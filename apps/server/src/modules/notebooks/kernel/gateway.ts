import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/**
 * Jupyter Kernel Gateway 的 REST + WebSocket 客户端（Jupyter messaging protocol 5.3，JSON 帧）。
 *
 *   REST  POST /api/kernels              → { id }
 *         POST /api/kernels/:id/interrupt
 *         POST /api/kernels/:id/restart
 *         DELETE /api/kernels/:id
 *   WS    /api/kernels/:id/channels      shell / iopub / control / stdin 复用一条连接
 */
export interface GatewayEndpoint {
  /** http://host:port */
  baseUrl: string;
  token: string;
}

export interface JupyterMessage<C = Record<string, unknown>> {
  header: {
    msg_id: string;
    msg_type: string;
    session: string;
    username: string;
    date: string;
    version: string;
  };
  parent_header: { msg_id?: string; msg_type?: string } & Record<string, unknown>;
  metadata: Record<string, unknown>;
  content: C;
  channel: 'shell' | 'iopub' | 'control' | 'stdin';
  buffers?: unknown[];
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class KernelGatewayClient {
  constructor(readonly endpoint: GatewayEndpoint) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.endpoint.token ? { Authorization: `token ${this.endpoint.token}` } : {}),
    };
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    const res = await fetch(`${this.endpoint.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok)
      throw new GatewayError(
        res.status,
        `内核服务 ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async ping(): Promise<boolean> {
    try {
      await this.call('GET', '/api', undefined, 3000);
      return true;
    } catch {
      return false;
    }
  }

  async startKernel(name = 'python3', env: Record<string, string> = {}): Promise<string> {
    // env 为空时不要传：Kernel Gateway 会用它整体替换内核进程的环境（Windows 上没了 SYSTEMROOT 内核直接起不来）
    const body = Object.keys(env).length ? { name, env } : { name };
    const res = await this.call<{ id: string }>('POST', '/api/kernels', body, 120_000);
    return res.id;
  }

  async kernelExists(id: string): Promise<boolean> {
    try {
      await this.call('GET', `/api/kernels/${id}`);
      return true;
    } catch (err) {
      if (err instanceof GatewayError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * 网关记录的内核执行状态（idle / busy / starting / restarting / dead…）。
   * 内核不存在返回 null；网关版本太老、不报状态时返回 'unknown'。
   */
  async kernelState(id: string): Promise<string | null> {
    try {
      const k = await this.call<{ execution_state?: string } | undefined>(
        'GET',
        `/api/kernels/${id}`,
        undefined,
        10_000,
      );
      return k?.execution_state ?? 'unknown';
    } catch (err) {
      if (err instanceof GatewayError && err.status === 404) return null;
      throw err;
    }
  }

  interrupt(id: string) {
    return this.call('POST', `/api/kernels/${id}/interrupt`);
  }

  restart(id: string) {
    return this.call('POST', `/api/kernels/${id}/restart`, undefined, 120_000);
  }

  async shutdown(id: string) {
    try {
      await this.call('DELETE', `/api/kernels/${id}`);
    } catch (err) {
      if (!(err instanceof GatewayError && err.status === 404)) throw err;
    }
  }

  connect(id: string): WebSocket {
    const url = `${this.endpoint.baseUrl.replace(/^http/, 'ws')}/api/kernels/${id}/channels`;
    return new WebSocket(url, {
      headers: this.endpoint.token ? { Authorization: `token ${this.endpoint.token}` } : {},
      maxPayload: 64 * 1024 * 1024,
    });
  }
}

export function makeMessage<C>(
  session: string,
  channel: JupyterMessage['channel'],
  msgType: string,
  content: C,
): JupyterMessage<C> {
  return {
    header: {
      msg_id: randomUUID(),
      msg_type: msgType,
      session,
      username: 'srh',
      date: new Date().toISOString(),
      version: '5.3',
    },
    parent_header: {},
    metadata: {},
    content,
    channel,
    buffers: [],
  };
}
