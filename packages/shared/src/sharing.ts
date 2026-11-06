import { z } from 'zod';
import { tr } from './i18n';

/**
 * 个人 / 团队空间与分享（飞书式）。归属：feat/personal-team-spaces（API.md §2.19）。
 *
 * - 文档、论文各自属于一个空间：`team`（项目共享区，项目成员按角色访问）或 `personal`
 *   （某个成员的个人空间，默认只有本人可见）。
 * - 个人空间的资源可以：按人邀请（每人一个访问级别）、开启链接分享（谁能通过链接访问 +
 *   访问级别），链接可以关闭（= 仅邀请的人）或重置（旧链接全部失效）。
 * - 访问级别从低到高：none < view（可阅读）< comment（可评论）< edit（可编辑）< manage（所有者）。
 */

export const ResourceSpace = z.enum(['team', 'personal']);
export type ResourceSpace = z.infer<typeof ResourceSpace>;

export const RESOURCE_SPACE_LABEL: Record<ResourceSpace, string> = {
  team: tr('团队空间'),
  personal: tr('个人空间'),
};

/** 可以分享的资源 */
export const ShareResourceKind = z.enum(['document', 'paper']);
export type ShareResourceKind = z.infer<typeof ShareResourceKind>;

/** 授予别人的访问级别（邀请与链接共用） */
export const ShareLevel = z.enum(['view', 'comment', 'edit']);
export type ShareLevel = z.infer<typeof ShareLevel>;

export const SHARE_LEVEL_LABEL: Record<ShareLevel, string> = {
  view: tr('可阅读'),
  comment: tr('可评论'),
  edit: tr('可编辑'),
};

/** 某个人对某个资源的实际权限 */
export const AccessLevel = z.enum(['none', 'view', 'comment', 'edit', 'manage']);
export type AccessLevel = z.infer<typeof AccessLevel>;

export const ACCESS_LEVEL_TEXT: Record<AccessLevel, string> = {
  none: tr('无权访问'),
  view: tr('可阅读'),
  comment: tr('可评论'),
  edit: tr('可编辑'),
  manage: tr('所有者'),
};

const ACCESS_RANK: Record<AccessLevel, number> = {
  none: 0,
  view: 1,
  comment: 2,
  edit: 3,
  manage: 4,
};

/** a 是否至少达到 b */
export function accessAtLeast(a: AccessLevel | null | undefined, b: AccessLevel): boolean {
  return ACCESS_RANK[a ?? 'none'] >= ACCESS_RANK[b];
}

/** 取较高的那个 */
export function maxAccess(...levels: (AccessLevel | null | undefined)[]): AccessLevel {
  let best: AccessLevel = 'none';
  for (const l of levels) if (l && ACCESS_RANK[l] > ACCESS_RANK[best]) best = l;
  return best;
}

/**
 * 链接分享的范围：
 * - invited：链接关闭，只有所有者邀请的人能访问
 * - project：本课题成员拿到链接即可访问
 * - anyone：任何登录研协的人拿到链接即可访问（包括课题外的人）
 */
export const LinkScope = z.enum(['invited', 'project', 'anyone']);
export type LinkScope = z.infer<typeof LinkScope>;

export const LINK_SCOPE_LABEL: Record<LinkScope, string> = {
  invited: tr('仅邀请的人'),
  project: tr('课题成员'),
  anyone: tr('知道链接的人'),
};

/** 分享链接的路径：`/s/<token>`（前端路由，服务端解析见 GET /share/:token） */
export const SHARE_LINK_PATH = '/s';

export const ShareGrant = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  avatarColor: z.number().int(),
  level: ShareLevel,
  /** 不是本课题成员（通过邮箱邀请的外部账号） */
  external: z.boolean(),
  createdAt: z.string(),
});
export type ShareGrant = z.infer<typeof ShareGrant>;

/** GET P/shares/:kind/:id：分享设置（只有所有者能看到 token 与邀请名单） */
export const ShareSettings = z.object({
  resourceKind: ShareResourceKind,
  resourceId: z.string(),
  projectId: z.string(),
  space: ResourceSpace,
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  /** 当前用户的权限 */
  access: AccessLevel,
  link: z.object({
    scope: LinkScope,
    level: ShareLevel,
    /** 链接 token；非所有者看不到（null） */
    token: z.string().nullable(),
  }),
  grants: z.array(ShareGrant),
});
export type ShareSettings = z.infer<typeof ShareSettings>;

/** PATCH P/shares/:kind/:id/link */
export const ShareLinkUpdateInput = z.object({
  scope: LinkScope.optional(),
  level: ShareLevel.optional(),
});
export type ShareLinkUpdateInput = z.infer<typeof ShareLinkUpdateInput>;

/** POST P/shares/:kind/:id/grants：按人邀请（成员 id 或研协账号邮箱） */
export const ShareGrantInput = z
  .object({
    userIds: z.array(z.string().min(1)).max(50).default([]),
    emails: z.array(z.string().trim().email().max(200)).max(20).default([]),
    level: ShareLevel.default('view'),
  })
  .refine((v) => v.userIds.length + v.emails.length > 0, { message: tr('至少邀请一个人') });
export type ShareGrantInput = z.input<typeof ShareGrantInput>;

/** PATCH P/shares/:kind/:id/grants/:userId */
export const ShareGrantUpdateInput = z.object({ level: ShareLevel });
export type ShareGrantUpdateInput = z.infer<typeof ShareGrantUpdateInput>;

/** POST P/docs/:docId/move、POST P/library/papers/:paperId/move */
export const MoveSpaceInput = z.object({ space: ResourceSpace });
export type MoveSpaceInput = z.infer<typeof MoveSpaceInput>;

/** GET /share/:token：打开分享链接 */
export const ShareResolveResult = z.object({
  projectId: z.string(),
  projectName: z.string(),
  resourceKind: ShareResourceKind,
  resourceId: z.string(),
  title: z.string(),
  ownerName: z.string().nullable(),
  access: AccessLevel,
  /** 当前用户是不是这个课题的成员（是 → 在课题里打开；否 → 独立分享页） */
  member: z.boolean(),
});
export type ShareResolveResult = z.infer<typeof ShareResolveResult>;

/** 列表的空间筛选：team 团队空间、personal 我的空间、shared 与我共享、all 全部可见 */
export const SpaceFilter = z.enum(['team', 'personal', 'shared', 'all']);
export type SpaceFilter = z.infer<typeof SpaceFilter>;

/**
 * 分享事件（API.md §4）：分享设置变了或资源换了空间。只带 id，推给项目所有成员，
 * 客户端据此重新拉列表与权限（新获得 / 失去访问权的人都能及时刷新）。
 */
export const SHARING_EVENT_PAYLOADS = {
  'share.updated': z.object({
    resourceKind: ShareResourceKind,
    resourceId: z.string(),
    /** link 链接设置、grants 邀请名单、space 换了空间 */
    reason: z.enum(['link', 'grants', 'space']),
  }),
} as const;
