import { api, setApiErrorListener } from './api';
import { tr } from '@/lib/i18n';

/**
 * 前端错误收集：最近 20 条留在内存环形缓冲里（反馈对话框的诊断信息会带上），
 * 同时上报到 `POST /feedback/client-errors`，同一条消息 60 秒内只报一次。
 */

export interface ClientErrorEntry {
  message: string;
  stack?: string | undefined;
  source: 'error' | 'rejection' | 'api';
  route: string;
  at: string;
}

export const CLIENT_ERROR_BUFFER_SIZE = 20;
export const CLIENT_ERROR_THROTTLE_MS = 60_000;
const REPORT_PATH = '/feedback/client-errors';

type Reporter = (payload: {
  message: string;
  stack?: string;
  url?: string;
  route?: string;
  userAgent?: string;
  appVersion?: string;
  level: 'error' | 'warn';
}) => Promise<unknown>;

/** 前端构建版本；测试环境没有 define 时为 undefined。 */
export function appVersion(): string | undefined {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined;
}

export interface ClientErrorCollector {
  record: (entry: Omit<ClientErrorEntry, 'at' | 'route'> & { route?: string }) => void;
  recent: () => ClientErrorEntry[];
  clear: () => void;
}

/** 纯逻辑部分，便于单测：缓冲 + 按消息节流上报。 */
export function createClientErrorCollector(options: {
  report: Reporter;
  now?: () => number;
  size?: number;
  throttleMs?: number;
  route?: () => string;
}): ClientErrorCollector {
  const size = options.size ?? CLIENT_ERROR_BUFFER_SIZE;
  const throttleMs = options.throttleMs ?? CLIENT_ERROR_THROTTLE_MS;
  const now = options.now ?? (() => Date.now());
  const routeOf = options.route ?? (() => '');
  const buffer: ClientErrorEntry[] = [];
  const lastSent = new Map<string, number>();

  return {
    record(input) {
      const message = (input.message || tr('未知错误')).slice(0, 2000);
      const t = now();
      const entry: ClientErrorEntry = {
        message,
        stack: input.stack?.slice(0, 8000),
        source: input.source,
        route: input.route ?? routeOf(),
        at: new Date(t).toISOString(),
      };
      buffer.push(entry);
      if (buffer.length > size) buffer.splice(0, buffer.length - size);

      const prev = lastSent.get(message);
      if (prev !== undefined && t - prev < throttleMs) return;
      lastSent.set(message, t);
      // 表不要无限长：丢掉过期的
      if (lastSent.size > 200) {
        for (const [k, v] of lastSent) if (t - v >= throttleMs) lastSent.delete(k);
      }
      const payload: Parameters<Reporter>[0] = {
        message,
        route: entry.route,
        level: input.source === 'api' ? 'warn' : 'error',
      };
      if (entry.stack) payload.stack = entry.stack;
      if (typeof location !== 'undefined') payload.url = location.href.slice(0, 2000);
      if (typeof navigator !== 'undefined') payload.userAgent = navigator.userAgent.slice(0, 500);
      const version = appVersion();
      if (version) payload.appVersion = version;
      options.report(payload).catch(() => {
        // 上报失败就算了，不能再记一条错误
      });
    },
    recent: () => buffer.slice(),
    clear: () => {
      buffer.length = 0;
      lastSent.clear();
    },
  };
}

function currentRoute(): string {
  if (typeof location === 'undefined') return '';
  return `${location.pathname}${location.search}`;
}

let collector: ClientErrorCollector | null = null;

function getCollector(): ClientErrorCollector {
  collector ??= createClientErrorCollector({
    report: (payload) => api.post(REPORT_PATH, payload),
    route: currentRoute,
  });
  return collector;
}

/** 最近的前端错误（新的在后）。 */
export function recentClientErrors(): ClientErrorEntry[] {
  return collector?.recent() ?? [];
}

function describe(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error)
    return { message: reason.message || reason.name, stack: reason.stack ?? '' };
  if (typeof reason === 'string') return { message: reason };
  try {
    return { message: JSON.stringify(reason) ?? String(reason) };
  } catch {
    return { message: String(reason) };
  }
}

let initialized = false;

/** 在 main.tsx 里调用一次。 */
export function initClientErrors(): () => void {
  if (initialized || typeof window === 'undefined') return () => {};
  initialized = true;
  const c = getCollector();
  const onError = (e: ErrorEvent) => {
    // 资源加载失败（img/script）没有 message，忽略
    if (!e.message) return;
    const stack = e.error instanceof Error ? e.error.stack : undefined;
    c.record({ message: e.message, stack, source: 'error' });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const { message, stack } = describe(e.reason);
    c.record({ message, stack: stack || undefined, source: 'rejection' });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  setApiErrorListener(({ method, path, error }) => {
    if (path.startsWith(REPORT_PATH)) return;
    const status = error.status === 0 ? tr('网络错误') : String(error.status);
    c.record({
      message: `${method} ${path.split('?')[0]} → ${status} ${error.code}`,
      source: 'api',
    });
  });
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    setApiErrorListener(null);
    initialized = false;
  };
}
