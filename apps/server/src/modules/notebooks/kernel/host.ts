import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../../config';
import { DockerClient } from '../../../sandbox/docker';
import type { GatewayEndpoint } from './gateway';
import { KernelGatewayClient } from './gateway';

/**
 * 内核宿主：给每个项目一个 Kernel Gateway 端点。
 *   gateway  本地开发：所有项目共用 KERNEL_GATEWAY_URL（一个本地 jupyter kernelgateway）
 *   docker   生产：每个项目一个隔离容器 srh-kernel-<projectId>，
 *            只接入自己的内部网络 srh-kn-<projectId>（app 容器也接入这个网络，DB 不在上面），
 *            限 CPU / 内存 / pids，cap-drop ALL，no-new-privileges，只读根文件系统，
 *            项目文件放在具名卷 srh-nb-<projectId>（挂到 /home/jovyan/work，重启不丢）。
 */
/** 容器的内存超限情况：kills = cgroup 里的 oom_kill 计数（读不到为 null），oomKilled = docker 的 State.OOMKilled */
export interface OomState {
  kills: number | null;
  oomKilled: boolean;
}

export interface KernelContainer {
  name: string;
  /** 容器标签 srh.project；没有标签时为 null（不认识的容器不动） */
  projectId: string | null;
  running: boolean;
}

export interface KernelHost {
  readonly mode: 'gateway' | 'docker';
  endpoint(projectId: string): Promise<GatewayEndpoint>;
  /** 项目没有活跃内核了：docker 模式停掉容器 */
  release(projectId: string): Promise<void>;
  /** 项目的内存超限计数（内核崩溃后判断是不是 OOM）；不支持的宿主不实现 */
  oomState?(projectId: string): Promise<OomState | null>;
  /** 项目归档：删除它的内核容器（数据卷保留） */
  remove?(projectId: string): Promise<void>;
  /** 列出所有内核容器（定期清理已归档项目的容器） */
  list?(): Promise<KernelContainer[]>;
}

export class GatewayHost implements KernelHost {
  readonly mode = 'gateway' as const;
  constructor(private readonly ep: GatewayEndpoint) {}
  async endpoint(): Promise<GatewayEndpoint> {
    const ok = await new KernelGatewayClient(this.ep).ping();
    if (!ok) throw new Error(`连不上内核服务 ${this.ep.baseUrl}`);
    return this.ep;
  }
  async release() {
    /* 共享网关，不停 */
  }
}

const slug = (projectId: string) => projectId.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
/** pip 白名单代理在内核网络里的别名 */
const PIP_PROXY_ALIAS = 'pypi-proxy';
/** Linux 网卡名最长 15 字符：srhkn + 项目 id 哈希前 10 位 */
export const bridgeName = (projectId: string) =>
  `srhkn${createHash('sha1').update(projectId).digest('hex').slice(0, 10)}`;

export class DockerHost implements KernelHost {
  readonly mode = 'docker' as const;
  private readonly docker: DockerClient;
  private readonly starting = new Map<string, Promise<GatewayEndpoint>>();

  constructor(private readonly config: AppConfig) {
    this.docker = new DockerClient({ host: config.DOCKER_HOST });
  }

  names(projectId: string) {
    const s = slug(projectId);
    return { container: `srh-kernel-${s}`, network: `srh-kn-${s}`, volume: `srh-nb-${s}` };
  }

  endpoint(projectId: string): Promise<GatewayEndpoint> {
    let p = this.starting.get(projectId);
    if (!p) {
      p = this.ensure(projectId).finally(() => this.starting.delete(projectId));
      this.starting.set(projectId, p);
    }
    return p;
  }

  private async ensure(projectId: string): Promise<GatewayEndpoint> {
    const cfg = this.config;
    const { container, network, volume } = this.names(projectId);
    await this.docker.ensureNetwork(network, {
      internal: !cfg.KERNEL_ALLOW_INTERNET,
      // 固定网卡名前缀 srhkn，宿主机防火墙（deploy/kernel-firewall.sh）用 srhkn+ 通配：
      // 只放行 app → 内核 :8888，内核不能主动连 app 或宿主机端口
      options: { 'com.docker.network.bridge.name': bridgeName(projectId) },
    });
    // app 自己也接入这个网络才能连到内核；在容器里时 HOSTNAME 就是自己的容器 ID
    const self = cfg.KERNEL_APP_CONTAINER || process.env.HOSTNAME || '';
    if (self) await this.docker.connectNetwork(network, self);
    // pip 出网：把白名单代理（只放行 PyPI，见 deploy/pypi-proxy）接入本项目的内核网络，别名 pypi-proxy。
    // 内核网络本身仍是 internal，没配代理的流量照样出不去。
    const proxy = cfg.KERNEL_PIP_PROXY_CONTAINER;
    const proxyUrl = proxy ? `http://${PIP_PROXY_ALIAS}:3128` : '';
    if (proxy) await this.docker.connectNetwork(network, proxy, [PIP_PROXY_ALIAS]);

    const imageId = await this.docker.imageId(cfg.KERNEL_IMAGE);
    if (!imageId) {
      throw new Error(
        `服务器上还没有内核镜像 ${cfg.KERNEL_IMAGE}（部署时会构建，见 deploy/kernel）`,
      );
    }
    let info = await this.docker.inspect(container);
    if (info && (info.image !== imageId || (info.labels['srh.proxy'] ?? '') !== proxyUrl)) {
      // 镜像换了（升级 / 重建）或 pip 代理设置变了：重建容器，数据卷保留
      await this.docker.remove(container, { force: true });
      info = null;
    }
    if (!info) {
      const token = randomBytes(24).toString('hex');
      await this.docker.createContainer({
        name: container,
        image: cfg.KERNEL_IMAGE,
        env: {
          KG_AUTH_TOKEN: token,
          HOME: '/home/jovyan/work',
          IPYTHONDIR: '/tmp/ipython',
          JUPYTER_RUNTIME_DIR: '/tmp/jupyter-runtime',
          JUPYTER_DATA_DIR: '/tmp/jupyter-data',
          ...(proxyUrl
            ? {
                HTTP_PROXY: proxyUrl,
                HTTPS_PROXY: proxyUrl,
                http_proxy: proxyUrl,
                https_proxy: proxyUrl,
              }
            : {}),
        },
        labels: {
          'srh.kind': 'kernel',
          'srh.project': projectId,
          'srh.token': token,
          'srh.image': cfg.KERNEL_IMAGE,
          'srh.proxy': proxyUrl,
        },
        network,
        cpus: cfg.KERNEL_CPUS,
        memoryBytes: cfg.KERNEL_MEMORY_MB * 1024 * 1024,
        pidsLimit: 512,
        readOnlyRoot: true,
        tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m' },
        volumes: [{ name: volume, target: '/home/jovyan/work' }],
        workingDir: '/home/jovyan/work',
        user: '1000:100',
        capDrop: ['ALL'],
        noNewPrivileges: true,
        shmSizeBytes: 256 * 1024 * 1024,
        exposedPorts: [8888],
      });
      info = await this.docker.inspect(container);
    }
    if (!info) throw new Error('内核容器创建失败');
    if (!info.running) await this.docker.start(container);
    const ep: GatewayEndpoint = {
      baseUrl: `http://${container}:8888`,
      token: info.labels['srh.token'] ?? '',
    };
    const client = new KernelGatewayClient(ep);
    for (let i = 0; i < 120; i += 1) {
      if (await client.ping()) return ep;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('内核容器启动超时');
  }

  async release(projectId: string) {
    await this.docker.stop(this.names(projectId).container, 5);
  }

  /**
   * 内存超限情况。内核进程被 OOM killer 杀掉时容器本身通常还活着（PID 1 是 tini / 网关），
   * 所以以 cgroup 的 oom_kill 计数为准（v2: memory.events，v1: memory.oom_control）；
   * docker inspect 的 State.OOMKilled 作为补充（整个容器被杀时一定有）。
   */
  async oomState(projectId: string): Promise<OomState | null> {
    const { container } = this.names(projectId);
    let kills: number | null = null;
    try {
      const r = await this.docker.exec(
        container,
        [
          'sh',
          '-c',
          'cat /sys/fs/cgroup/memory.events 2>/dev/null || cat /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null',
        ],
        { timeoutMs: 10_000 },
      );
      const m = /^oom_kill\s+(\d+)/m.exec(r.stdout);
      if (m) kills = Number(m[1]);
    } catch {
      /* 容器没在运行 / 不允许 exec */
    }
    let oomKilled = false;
    try {
      const res = await this.docker.request(
        'GET',
        `/containers/${encodeURIComponent(container)}/json`,
      );
      if (res.status === 200) {
        const j = JSON.parse(res.body.toString('utf8')) as { State?: { OOMKilled?: boolean } };
        oomKilled = !!j.State?.OOMKilled;
      } else if (kills === null) {
        return null;
      }
    } catch {
      if (kills === null) return null;
    }
    return { kills, oomKilled };
  }

  async remove(projectId: string) {
    const { container, network } = this.names(projectId);
    await this.docker.remove(container, { force: true });
    // 项目专属网络也删掉（每项目一个 bridge，不删会耗尽地址池）；数据卷保留，恢复项目后文件还在
    await this.docker.removeNetwork(network).catch((err: unknown) => {
      console.warn(`[notebooks] 删除内核网络 ${network} 失败`, err);
    });
  }

  async list(): Promise<KernelContainer[]> {
    const all = await this.docker.listByLabel('srh.kind=kernel');
    return all
      .filter((c) => c.name.startsWith('srh-kernel-'))
      .map((c) => ({
        name: c.name,
        projectId: c.labels['srh.project'] || null,
        running: c.running,
      }));
  }
}

export function createKernelHost(config: AppConfig): KernelHost | null {
  if (config.KERNEL_MODE === 'gateway') {
    return new GatewayHost({
      baseUrl: config.KERNEL_GATEWAY_URL.replace(/\/$/, ''),
      token: config.KERNEL_GATEWAY_TOKEN,
    });
  }
  if (config.KERNEL_MODE === 'docker') return new DockerHost(config);
  return null;
}
