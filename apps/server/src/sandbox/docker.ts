import http from 'node:http';

/**
 * 最小 Docker Engine API 客户端（原生 node:http，不引 dockerode）。
 * notebook 内核容器、共享云电脑容器共用；改接口先和两边线程说一声。
 *
 * 连接：DOCKER_HOST=unix:///var/run/docker.sock（默认）或 tcp://docker-proxy:2375。
 * 生产环境走 tecnativa/docker-socket-proxy，只放行 CONTAINERS / IMAGES / NETWORKS / EXEC / POST。
 *
 * 安全默认（createContainer 不传就生效）：cap-drop ALL、no-new-privileges、pids 上限、
 * 非 root 用户由镜像决定、不挂宿主机目录（binds 只允许具名卷）。
 */
const API = '/v1.43';

export interface DockerOptions {
  /** unix:///path 或 tcp://host:port；默认 unix:///var/run/docker.sock */
  host?: string;
  timeoutMs?: number;
}

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface ContainerSpec {
  name: string;
  image: string;
  cmd?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /** 加入的网络（容器 DNS 名 = name） */
  network?: string;
  /** CPU 核数上限，如 1.5 */
  cpus?: number;
  memoryBytes?: number;
  /** 默认 = memoryBytes（不给 swap） */
  memorySwapBytes?: number;
  pidsLimit?: number;
  readOnlyRoot?: boolean;
  /** 挂载点 → 选项，如 { '/tmp': 'rw,size=256m' } */
  tmpfs?: Record<string, string>;
  /** 具名卷挂载：`volume:/path[:ro]`。不允许宿主机路径。 */
  binds?: string[];
  /** 具名卷挂载的结构化写法（与 binds 等价，二选一或混用） */
  volumes?: { name: string; target: string; readOnly?: boolean }[];
  /** 额外的 SecurityOpt（no-new-privileges 由 noNewPrivileges 控制，默认开） */
  securityOpt?: string[];
  user?: string;
  workingDir?: string;
  capDrop?: string[];
  capAdd?: string[];
  noNewPrivileges?: boolean;
  /** 容器内暴露的端口（只在内部网络可达，不映射到宿主机） */
  exposedPorts?: number[];
  shmSizeBytes?: number;
  restart?: 'no' | 'unless-stopped' | 'on-failure';
}

export interface ContainerInfo {
  id: string;
  name: string;
  running: boolean;
  status: string;
  labels: Record<string, string>;
  /** 容器创建时所用镜像的 ID（sha256:…），和 imageId() 比较即可判断镜像是否已重建 */
  image: string;
  /** 各网络里的 IP */
  ips: Record<string, string>;
}

export interface ContainerStats {
  /** 占宿主机单核的百分比之和（2 核跑满 = 200） */
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  pids: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseHost(host: string): { socketPath?: string; hostname?: string; port?: number } {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  if (host.startsWith('npipe://')) return { socketPath: host.slice('npipe://'.length) };
  const url = new URL(host.replace(/^tcp:/, 'http:'));
  return { hostname: url.hostname, port: Number(url.port || 2375) };
}

export function assertNamedVolumeBind(bind: string) {
  const src = bind.split(':')[0] ?? '';
  // Docker 具名卷名的合法字符；路径（/、.、C:\）都不满足
  if (/^[a-zA-Z]:[\\/]/.test(bind) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(src)) {
    throw new Error(`只允许具名卷挂载，不允许宿主机路径：${bind}`);
  }
}

export class DockerClient {
  private readonly target: ReturnType<typeof parseHost>;
  private readonly timeoutMs: number;

  constructor(opts: DockerOptions = {}) {
    this.target = parseHost(opts.host ?? process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** 发请求；返回 [status, body Buffer] */
  request(
    method: string,
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number; raw?: boolean } = {},
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          ...this.target,
          method,
          path: `${API}${path}`,
          headers: {
            Host: 'docker',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
          },
          timeout: opts.timeoutMs ?? this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} 超时`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async json<T>(method: string, path: string, body?: unknown, ok = [200, 201, 204]) {
    const res = await this.request(method, path, body);
    if (!ok.includes(res.status)) {
      let msg = res.body.toString('utf8');
      try {
        msg = (JSON.parse(msg) as { message?: string }).message ?? msg;
      } catch {
        /* 不是 JSON */
      }
      throw new DockerError(res.status, `docker ${method} ${path} → ${res.status}: ${msg}`);
    }
    if (res.body.length === 0) return undefined as T;
    return JSON.parse(res.body.toString('utf8')) as T;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/_ping', undefined, { timeoutMs: 3000 });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async ensureNetwork(
    name: string,
    opts: { internal?: boolean; options?: Record<string, string> } = {},
  ): Promise<void> {
    const list = await this.json<{ Name: string }[]>(
      'GET',
      `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [name] }))}`,
    );
    if (list.some((n) => n.Name === name)) return;
    await this.json('POST', '/networks/create', {
      Name: name,
      Driver: 'bridge',
      Internal: !!opts.internal,
      CheckDuplicate: true,
      Options: opts.options,
      Labels: { 'srh.managed': 'true' },
    });
  }

  /** 连接一个已存在的容器（如 app 自己）到网络；已连接时忽略 */
  async connectNetwork(network: string, container: string, aliases?: string[]): Promise<void> {
    const res = await this.request('POST', `/networks/${encodeURIComponent(network)}/connect`, {
      Container: container,
      ...(aliases?.length ? { EndpointConfig: { Aliases: aliases } } : {}),
    });
    if (res.status === 200 || res.status === 403 /* already */) return;
    const text = res.body.toString('utf8');
    if (/already exists|endpoint with name/i.test(text)) return;
    throw new DockerError(res.status, `docker network connect → ${res.status}: ${text}`);
  }

  /**
   * 删除网络；先把仍连着的容器（如 app 自己）断开。不存在时忽略。
   * 项目归档时用：每个项目一个 bridge 网络，不删会耗尽 Docker 的地址池。
   */
  async removeNetwork(name: string): Promise<void> {
    const res = await this.request('GET', `/networks/${encodeURIComponent(name)}`);
    if (res.status === 404) return;
    if (res.status === 200) {
      const info = JSON.parse(res.body.toString('utf8')) as {
        Containers?: Record<string, unknown>;
      };
      for (const id of Object.keys(info.Containers ?? {})) {
        await this.request('POST', `/networks/${encodeURIComponent(name)}/disconnect`, {
          Container: id,
          Force: true,
        });
      }
    }
    await this.json('DELETE', `/networks/${encodeURIComponent(name)}`, undefined, [204, 404]);
  }

  async imageExists(ref: string): Promise<boolean> {
    const res = await this.request('GET', `/images/${encodeURIComponent(ref)}/json`);
    return res.status === 200;
  }

  /** 镜像 ID（sha256:…）；不存在返回 null */
  async imageId(ref: string): Promise<string | null> {
    const res = await this.request('GET', `/images/${encodeURIComponent(ref)}/json`);
    if (res.status !== 200) return null;
    return (JSON.parse(res.body.toString('utf8')) as { Id?: string }).Id ?? null;
  }

  async ensureImage(ref: string): Promise<void> {
    if (await this.imageExists(ref)) return;
    const [repo, tag = 'latest'] = ref.split(/:(?=[^/]+$)/);
    const res = await this.request(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(repo ?? ref)}&tag=${encodeURIComponent(tag)}`,
      undefined,
      { timeoutMs: 15 * 60_000 },
    );
    if (res.status !== 200) {
      throw new DockerError(res.status, `拉取镜像 ${ref} 失败：${res.body.toString('utf8')}`);
    }
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    const binds = [
      ...(spec.binds ?? []),
      ...(spec.volumes ?? []).map((v) => `${v.name}:${v.target}${v.readOnly ? ':ro' : ''}`),
    ];
    for (const b of binds) assertNamedVolumeBind(b);
    const memory = spec.memoryBytes;
    const body = {
      Image: spec.image,
      Cmd: spec.cmd,
      Entrypoint: spec.entrypoint,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Labels: { 'srh.managed': 'true', ...(spec.labels ?? {}) },
      User: spec.user,
      WorkingDir: spec.workingDir,
      ExposedPorts: Object.fromEntries((spec.exposedPorts ?? []).map((p) => [`${p}/tcp`, {}])),
      HostConfig: {
        NetworkMode: spec.network ?? 'none',
        NanoCpus: spec.cpus ? Math.round(spec.cpus * 1e9) : undefined,
        Memory: memory,
        MemorySwap: memory ? (spec.memorySwapBytes ?? memory) : undefined,
        PidsLimit: spec.pidsLimit ?? 512,
        ReadonlyRootfs: !!spec.readOnlyRoot,
        Tmpfs: spec.tmpfs,
        Binds: binds.length ? binds : undefined,
        CapDrop: spec.capDrop ?? ['ALL'],
        CapAdd: spec.capAdd,
        SecurityOpt: [
          ...(spec.noNewPrivileges === false ? [] : ['no-new-privileges:true']),
          ...(spec.securityOpt ?? []),
        ],
        ShmSize: spec.shmSizeBytes,
        RestartPolicy: { Name: spec.restart ?? 'no' },
        Init: true,
      },
    };
    const res = await this.json<{ Id: string }>(
      'POST',
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      body,
    );
    return res.Id;
  }

  async start(name: string): Promise<void> {
    await this.json('POST', `/containers/${encodeURIComponent(name)}/start`, undefined, [204, 304]);
  }

  async stop(name: string, timeoutSec = 5): Promise<void> {
    await this.json(
      'POST',
      `/containers/${encodeURIComponent(name)}/stop?t=${timeoutSec}`,
      undefined,
      [204, 304, 404],
    );
  }

  async remove(name: string, opts: { force?: boolean; volumes?: boolean } = {}): Promise<void> {
    await this.json(
      'DELETE',
      `/containers/${encodeURIComponent(name)}?force=${opts.force ? 1 : 0}&v=${opts.volumes ? 1 : 0}`,
      undefined,
      [204, 404],
    );
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    const res = await this.request('GET', `/containers/${encodeURIComponent(name)}/json`);
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new DockerError(res.status, `docker inspect ${name} → ${res.status}`);
    }
    const j = JSON.parse(res.body.toString('utf8')) as {
      Id: string;
      Name: string;
      Image: string;
      State: { Running: boolean; Status: string };
      Config: { Labels: Record<string, string> | null };
      NetworkSettings: { Networks: Record<string, { IPAddress: string }> | null };
    };
    return {
      id: j.Id,
      name: j.Name.replace(/^\//, ''),
      running: j.State.Running,
      status: j.State.Status,
      labels: j.Config.Labels ?? {},
      image: j.Image ?? '',
      ips: Object.fromEntries(
        Object.entries(j.NetworkSettings.Networks ?? {}).map(([k, v]) => [k, v.IPAddress]),
      ),
    };
  }

  async listByLabel(label: string, all = true): Promise<ContainerInfo[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const list = await this.json<
      {
        Id: string;
        Names: string[];
        ImageID?: string;
        State: string;
        Status: string;
        Labels: Record<string, string>;
        NetworkSettings?: { Networks?: Record<string, { IPAddress: string }> };
      }[]
    >('GET', `/containers/json?all=${all ? 1 : 0}&filters=${filters}`);
    return list.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      running: c.State === 'running',
      status: c.Status,
      labels: c.Labels ?? {},
      image: c.ImageID ?? '',
      ips: Object.fromEntries(
        Object.entries(c.NetworkSettings?.Networks ?? {}).map(([k, v]) => [k, v.IPAddress]),
      ),
    }));
  }

  /** CPU / 内存一次性快照（stream=false）；容器不存在或没在运行返回 null */
  async stats(name: string): Promise<ContainerStats | null> {
    const res = await this.request(
      'GET',
      `/containers/${encodeURIComponent(name)}/stats?stream=false`,
      undefined,
      { timeoutMs: 10_000 },
    );
    if (res.status === 404 || res.status === 409) return null;
    if (res.status !== 200)
      throw new DockerError(res.status, `docker stats ${name} → ${res.status}`);
    const j = JSON.parse(res.body.toString('utf8')) as {
      cpu_stats?: {
        cpu_usage?: { total_usage?: number };
        system_cpu_usage?: number;
        online_cpus?: number;
      };
      precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
      memory_stats?: {
        usage?: number;
        limit?: number;
        stats?: { inactive_file?: number; cache?: number };
      };
      pids_stats?: { current?: number };
    };
    const cpuDelta =
      (j.cpu_stats?.cpu_usage?.total_usage ?? 0) - (j.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (j.cpu_stats?.system_cpu_usage ?? 0) - (j.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = j.cpu_stats?.online_cpus ?? 1;
    const cache = j.memory_stats?.stats?.inactive_file ?? j.memory_stats?.stats?.cache ?? 0;
    return {
      cpuPercent: sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0,
      memoryBytes: Math.max(0, (j.memory_stats?.usage ?? 0) - cache),
      memoryLimitBytes: j.memory_stats?.limit ?? 0,
      pids: j.pids_stats?.current ?? 0,
    };
  }

  /** 在容器里执行命令并等它结束（stdout/stderr 用 Docker 的多路复用流解析） */
  async exec(
    name: string,
    cmd: string[],
    opts: { user?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const created = await this.json<{ Id: string }>(
      'POST',
      `/containers/${encodeURIComponent(name)}/exec`,
      {
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
        User: opts.user,
        Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      },
    );
    const res = await this.request(
      'POST',
      `/exec/${created.Id}/start`,
      { Detach: false, Tty: false },
      { timeoutMs: opts.timeoutMs ?? 60_000 },
    );
    const { stdout, stderr } = demuxDockerStream(res.body);
    const info = await this.json<{ ExitCode: number | null }>('GET', `/exec/${created.Id}/json`);
    return { exitCode: info.ExitCode ?? -1, stdout, stderr };
  }
}

/** Docker attach 流：8 字节头（stream type, 0,0,0, size uint32 BE）+ 数据 */
export function demuxDockerStream(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = buf.readUInt32BE(i + 4);
    const chunk = buf.subarray(i + 8, i + 8 + size);
    if (type === 2) err.push(chunk);
    else out.push(chunk);
    i += 8 + size;
  }
  if (i === 0 && buf.length > 0) out.push(buf); // TTY 模式没有头
  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}
