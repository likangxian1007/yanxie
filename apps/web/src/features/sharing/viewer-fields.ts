import type { AccessLevel, ResourceSpace } from '@srh/shared';

interface ViewerFields {
  space?: ResourceSpace | undefined;
  access?: AccessLevel | undefined;
  shared?: boolean | undefined;
}

/**
 * 实时事件（document.updated / paper.updated）的载荷对所有人都一样，不带「我」的权限字段
 * （access / shared）。用事件覆盖缓存时沿用缓存里的旧值，否则别人改一个字，
 * 我这边就丢了权限、界面退回按课题角色判断（只读分享会被误显示成可编辑）。
 * 空间变了就不沿用：移动空间会发 share.updated，客户端随后重新拉取。
 */
export function keepViewerFields<T extends ViewerFields>(prev: T | undefined, next: T): T {
  if (!prev || next.access !== undefined) return next;
  if ((prev.space ?? 'team') !== (next.space ?? 'team')) return next;
  const out = { ...next };
  if (prev.access !== undefined) out.access = prev.access;
  if (next.shared === undefined && prev.shared !== undefined) out.shared = prev.shared;
  return out;
}
