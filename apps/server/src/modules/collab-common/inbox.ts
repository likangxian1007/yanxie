import type { ActorRef, InboxItem, InboxKind } from '@srh/shared';
import type { AppContext } from '../../context';
import * as inbox from '../inbox/service';

/**
 * 协作模块写“待我处理”的入口：转调后端线程的 modules/inbox/service.ts（去重、事件推送都在那边）。
 * 保留这一层是为了让协作模块的调用签名稳定。
 */
export interface InboxInput {
  projectId: string;
  userId: string;
  kind: InboxKind;
  title: string;
  href: string;
  sourceId: string;
}

export async function createInboxItem(
  ctx: AppContext,
  input: InboxInput,
  _actor?: ActorRef,
): Promise<InboxItem> {
  return inbox.createInboxItem(ctx, input);
}

/** 某个来源（审阅、卡片…）处理完了：把对应收件箱项标记完成。userId 不传 = 所有人。 */
export async function markInboxDoneBySource(
  ctx: AppContext,
  _projectId: string,
  sourceId: string,
  _actor?: ActorRef,
  userId?: string,
): Promise<void> {
  await inbox.markInboxDoneBySource(ctx, sourceId, userId ? { userId } : {});
}
