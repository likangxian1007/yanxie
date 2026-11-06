import { useQuery } from '@tanstack/react-query';
import type { InboxItem } from '@srh/shared';
import { inboxQueryOptions } from './inbox-api';

const countItems = (items: InboxItem[]) => items.length;

/**
 * 当前项目“待我处理”里还没完成的条目数（侧栏、顶栏的徽标用）。
 * 与待我处理页共用 qk.inbox(pid, false) 缓存：没有缓存时会自己拉一次，
 * 之后靠实时事件（inbox.created / inbox.updated）和页面里的乐观更新保持同步。
 * 没有项目或还在加载时返回 0。
 */
export function useInboxCount(projectId: string): number {
  const { data } = useQuery({ ...inboxQueryOptions(projectId, false), select: countItems });
  return data ?? 0;
}
