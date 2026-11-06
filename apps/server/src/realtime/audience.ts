import type { AnyProjectEvent } from '@srh/shared';

/**
 * 个人空间资源（文档、论文）的事件受众：所有者 + 被邀请的人 + 当前有效的链接访问者。
 * realtime/access.ts 的 canSeeEvent 是同步热路径，这里用内存表；
 * 由 modules/sharing 在资源建立、移动、分享设置变化时更新，订阅项目时按项目整批加载。
 *
 * 规则（fail closed）：
 * - 事件 payload 自带 space=personal 时，只给 payload.ownerUserId 与表里登记的受众；
 * - payload 不带空间信息（删除、评论、版本、提案）时，按资源 id 查表，登记为个人资源的同样过滤。
 */
interface Audience {
  ownerUserId: string | null;
  users: Set<string>;
}

const personal = new Map<string, Audience>();

export function setPersonalAudience(
  resourceId: string,
  ownerUserId: string | null,
  users: Iterable<string> = [],
) {
  personal.set(resourceId, { ownerUserId, users: new Set(users) });
}

/** 资源移入团队空间：之后所有成员都能看到 */
export function clearPersonalAudience(resourceId: string) {
  personal.delete(resourceId);
}

export function isPersonalResource(resourceId: string): boolean {
  return personal.has(resourceId);
}

export function inAudience(resourceId: string, userId: string): boolean {
  const a = personal.get(resourceId);
  if (!a) return true;
  return a.ownerUserId === userId || a.users.has(userId);
}

type Loader = (projectId: string) => Promise<void>;
let loader: Loader | null = null;

/** sharing 模块注册：从库里加载某个项目所有个人资源的受众 */
export function registerAudienceLoader(fn: Loader) {
  loader = fn;
}

export async function loadAudiences(projectId: string) {
  if (loader) await loader(projectId);
}

/** 事件对应的资源 id（文档、论文、评论所属文档、版本 / 提案的目标）；无关事件返回 null */
export function eventResourceId(event: AnyProjectEvent): string | null {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'document.created':
    case 'document.updated':
    case 'document.deleted':
    case 'paper.created':
    case 'paper.updated':
    case 'paper.deleted':
      return typeof p.id === 'string' ? p.id : null;
    case 'paper.notes.changed':
    case 'paper.annotations.changed':
    case 'paper.qa.changed':
      return typeof p.paperId === 'string' ? p.paperId : null;
    case 'document.version_created':
    case 'document.comment_created':
    case 'document.comment_updated':
    case 'document.comment_deleted':
      return typeof p.documentId === 'string' ? p.documentId : null;
    case 'version.created':
    case 'proposal.created':
    case 'proposal.updated':
      return typeof p.targetId === 'string' ? p.targetId : null;
    default:
      return null;
  }
}

/** 某个用户能否收到这条事件（只管个人资源；其余规则在 access.ts） */
export function canSeeResourceEvent(userId: string, event: AnyProjectEvent): boolean {
  const id = eventResourceId(event);
  if (!id) return true;
  const p = event.payload as { space?: string; ownerUserId?: string | null };
  if (p.space === 'personal') {
    if (p.ownerUserId === userId) return true;
    const a = personal.get(id);
    return !!a && a.users.has(userId);
  }
  if (p.space === 'team') return true;
  return inAudience(id, userId);
}

/** 事件推送前维护表：资源的 created / updated 事件自带空间信息 */
export function trackResourceEvent(event: AnyProjectEvent) {
  if (
    event.type !== 'document.created' &&
    event.type !== 'document.updated' &&
    event.type !== 'paper.created' &&
    event.type !== 'paper.updated'
  ) {
    return;
  }
  const p = event.payload as { id: string; space?: string; ownerUserId?: string | null };
  if (p.space === 'team') clearPersonalAudience(p.id);
  else if (p.space === 'personal' && !personal.has(p.id)) {
    setPersonalAudience(p.id, p.ownerUserId ?? null);
  }
}
