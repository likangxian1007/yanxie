import { API_PREFIX, ApiErrorBody, type HealthResponse } from '@srh/shared';
import { BASE, joinBase } from './base-path';
import { tr, trServer } from '@/lib/i18n';

/**
 * REST 客户端：
 * - `/v1` 下的业务接口写相对路径即可：`api.get('/projects')` → `/api/v1/projects`
 * - 以 `/api/` 开头的路径原样使用（例如健康检查 `/api/health`）
 * - 自动带 Cookie（credentials: include），JSON 进 JSON 出
 * - 非 2xx 一律抛 `ApiRequestError`，message 是可以直接给用户看的中文
 */

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions extends Omit<RequestInit, 'body' | 'method'> {
  query?: QueryParams;
}

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  /** HTTP 状态码；0 表示网络错误（请求没有到达服务器） */
  readonly status: number;
  /** 服务端错误码（见 @srh/shared ERROR_STATUS），或 `network_error` / `http_<status>` */
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

const NETWORK_ERROR_MESSAGE = tr('无法连接到服务器。请检查网络或确认服务已启动，然后重试。');

function fallbackMessage(status: number): string {
  if (status === 400 || status === 422) return tr('提交的内容不完整或格式不对，请检查后重试。');
  if (status === 401) return tr('登录已失效，请重新登录。');
  if (status === 403) return tr('你没有权限进行这个操作，可以联系项目负责人开通。');
  if (status === 404) return tr('要找的内容不存在，可能已被删除或移动。');
  if (status === 409) return tr('内容已被他人修改，请刷新后再试。');
  if (status === 429) return tr('操作太频繁了，请稍等片刻再试。');
  if (status >= 500) return tr('服务器出了点问题，请稍后再试。');
  return tr('请求失败（{status}），请稍后再试。', { status });
}

export function resolveApiUrl(path: string, query?: QueryParams): string {
  return resolveApiUrlFor(BASE, path, query);
}

/** resolveApiUrl 的纯函数版本：`prefix` 是部署子路径（根路径为 ''），便于单测。 */
export function resolveApiUrlFor(prefix: string, path: string, query?: QueryParams): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const base = joinBase(
    prefix,
    normalized === '/api' || normalized.startsWith('/api/')
      ? normalized
      : `${API_PREFIX}${normalized}`,
  );
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
}

async function toApiError(res: Response): Promise<ApiRequestError> {
  let parsed: ApiErrorBody | null = null;
  try {
    const json: unknown = await res.json();
    const result = ApiErrorBody.safeParse(json);
    if (result.success) parsed = result.data;
  } catch {
    // 响应体不是 JSON：用兜底文案
  }
  return new ApiRequestError({
    status: res.status,
    code: parsed?.error.code ?? `http_${res.status}`,
    message: parsed?.error.message ? trServer(parsed.error.message) : fallbackMessage(res.status),
    details: parsed?.error.details,
  });
}

/** 5xx 与网络失败的旁路监听（lib/client-errors 用来收集最近错误），不影响抛错。 */
export type ApiErrorListener = (info: {
  method: string;
  path: string;
  error: ApiRequestError;
}) => void;
let apiErrorListener: ApiErrorListener | null = null;
export function setApiErrorListener(fn: ApiErrorListener | null): void {
  apiErrorListener = fn;
}
function notifyApiError(method: string, path: string, error: ApiRequestError): ApiRequestError {
  if (apiErrorListener && (error.status === 0 || error.status >= 500)) {
    try {
      apiErrorListener({ method, path, error });
    } catch {
      // 监听器出错不影响请求本身
    }
  }
  return error;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const { query, headers: initHeaders, ...init } = options;
  const headers = new Headers(initHeaders);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const hasBody = body !== undefined;
  // FormData（上传附件）交给浏览器生成带 boundary 的 Content-Type
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (hasBody && !isForm && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');

  let res: Response;
  try {
    res = await fetch(resolveApiUrl(path, query), {
      ...init,
      method,
      headers,
      credentials: 'include',
      body: hasBody ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw notifyApiError(
      method,
      path,
      new ApiRequestError({ status: 0, code: 'network_error', message: NETWORK_ERROR_MESSAGE }),
    );
  }

  if (!res.ok) throw notifyApiError(method, path, await toApiError(res));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiRequestError({
      status: res.status,
      code: 'invalid_json',
      message: tr('服务器返回了无法识别的数据，请稍后再试。'),
    });
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),
  delete: <T = void>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};

function isHealthResponse(value: unknown): value is HealthResponse {
  if (!value || typeof value !== 'object' || !('db' in value) || !('llm' in value)) return false;
  const health = value as Partial<HealthResponse>;
  const db = health.db;
  const llm = health.llm;
  return (
    (health.status === 'ok' || health.status === 'degraded') &&
    typeof health.version === 'string' &&
    typeof health.uptimeSec === 'number' &&
    typeof health.time === 'string' &&
    !!db &&
    typeof db.ok === 'boolean' &&
    (db.driver === 'pglite' || db.driver === 'postgres') &&
    (db.latencyMs === null || typeof db.latencyMs === 'number') &&
    (db.error === undefined || typeof db.error === 'string') &&
    !!llm &&
    typeof llm.configured === 'boolean' &&
    typeof llm.model === 'string'
  );
}

/** 健康端点在数据库异常时用 503 返回诊断体，其他错误仍按普通 API 错误处理。 */
export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let res: Response;
  try {
    res = await fetch(resolveApiUrl('/api/health'), {
      ...(signal ? { signal } : {}),
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError({ status: 0, code: 'network_error', message: NETWORK_ERROR_MESSAGE });
  }
  if (res.status === 503) {
    try {
      const body: unknown = await res.clone().json();
      if (isHealthResponse(body) && body.status === 'degraded' && !body.db.ok) return body;
    } catch {
      // 不是健康检查的诊断体时继续走普通错误处理。
    }
  }
  if (!res.ok) throw await toApiError(res);
  try {
    const body: unknown = await res.json();
    if (isHealthResponse(body)) return body;
  } catch {
    // 非 JSON 或不完整的响应统一报告为无法识别。
  }
  throw new ApiRequestError({
    status: res.status,
    code: 'invalid_json',
    message: tr('服务器返回了无法识别的数据，请稍后再试。'),
  });
}
