import { ApiError, type AccessLevel, type ShareResourceKind } from '@srh/shared';
import { memberRole } from '../../modules/collab-common/guard';
import { accessOf } from '../../modules/sharing/access';
import { loadResource } from '../../modules/sharing/service';
import type { PortViewer } from './collab-port';
import type { ToolContext } from './types';

/**
 * agent 读写文档 / 文献时代表谁（个人 / 团队空间权限，见 modules/sharing/access.ts）：
 * - 个人工作区的 agent（role = personal）：代表这个工作区的主人，能看到主人能看到的一切
 *   （团队空间 + 主人的个人空间 + 别人分享给主人的）。
 * - 协调者、团队线程：只看团队空间（userId = null），看不到任何人的个人空间。
 * 个人会话转交给协调者后由协调者接手，也就只看团队空间。
 */
const TEAM: PortViewer = { userId: null, role: 'member' };

const cache = new WeakMap<ToolContext, Promise<PortViewer>>();

export function agentViewer(tc: ToolContext): Promise<PortViewer> {
  let v = cache.get(tc);
  if (!v) {
    v = resolve(tc);
    cache.set(tc, v);
  }
  return v;
}

async function resolve(tc: ToolContext): Promise<PortViewer> {
  if (tc.session.role !== 'personal') return TEAM;
  const owner = tc.thread?.kind === 'personal' ? tc.thread.ownerUserId : null;
  const userId = owner ?? tc.session.workingForUserId ?? null;
  if (!userId) return TEAM;
  const role = await memberRole(tc.ctx, tc.project.id, userId);
  // 主人已经不是成员：退回团队视角（也看不到他的个人空间）
  return role ? { userId, role } : TEAM;
}

/** 直接查库的工具（编译、文献）用：agent 看不到就当不存在（404，不暴露个人资源） */
export async function agentAccess(
  tc: ToolContext,
  kind: ShareResourceKind,
  id: string,
): Promise<AccessLevel> {
  const res = await loadResource(tc.ctx, kind, id);
  const level =
    res && res.projectId === tc.project.id
      ? await accessOf(tc.ctx, res, await agentViewer(tc))
      : 'none';
  if (level === 'none') {
    throw new ApiError(
      'not_found',
      kind === 'document' ? '文档不存在，或你没有访问权限' : '论文不存在，或你没有访问权限',
    );
  }
  return level;
}
