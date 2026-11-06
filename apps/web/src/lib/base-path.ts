/**
 * 部署子路径（构建时 VITE_BASE_PATH，例如 `/app/`）。
 * 反向代理会先剥掉前缀再转给服务端，所以只有浏览器侧的 URL 需要带上它：
 * REST、WebSocket、站内绝对链接、静态资源。默认部署在根路径时 BASE 为空串，所有 URL 与原来一致。
 */

/** 去掉结尾斜杠的部署前缀：根路径为 ''，子路径如 '/app' */
export const BASE = normalizeBase(import.meta.env.BASE_URL);

export function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/u, '');
  if (!trimmed || trimmed === '.') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * 给站内绝对路径（以单个 `/` 开头）加上部署前缀；完整 URL、`//host`、`#…`、`data:` 等原样返回。
 * 已经带前缀的路径不会重复添加。
 */
export function joinBase(base: string, path: string): string {
  if (!base || !path.startsWith('/') || path.startsWith('//')) return path;
  if (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`)) return path;
  return `${base}${path}`;
}

export function withBase(path: string): string {
  return joinBase(BASE, path);
}

/** 当前站点（含部署前缀）的绝对地址，用于复制给别人的分享/邀请链接 */
export function absoluteUrl(path: string): string {
  return `${window.location.origin}${withBase(path)}`;
}
