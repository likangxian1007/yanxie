import type { Decision, Message, Thread } from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 站内引用 `#msg_…` / `#dec_…`（agent 在汇报、线程回复里常写）→ 跳到那条消息所在的位置。
 *
 * 消息可能在协作台时间线、项目线程或个人会话里，前端只凭 id 不知道在哪，所以：
 * 1. 链接先指向 `/p/:pid/go/:id`（GoToRefPage），
 * 2. 那里查 GET P/messages/:id（决策卡查 GET P/decisions/:id 拿 messageId），必要时再查线程类型，
 * 3. 换成真正的地址 `…#msg_…`，MessageFeed 按 hash 滚过去并闪一下。
 * 如果这条消息就在当前页面上，Markdown 的链接会直接滚过去，不经过跳转页。
 */

export type LinkRefKind = 'message' | 'decision';

/** `#msg_…` / `msg_…` / `#dec_…` → 引用；不是这两类返回 null */
export function parseLinkRef(ref: string): { kind: LinkRefKind; id: string } | null {
  const id = ref.replace(/^#/u, '').trim();
  if (!/^(msg|dec)_[0-9A-Za-z]+$/u.test(id)) return null;
  return { kind: id.startsWith('msg_') ? 'message' : 'decision', id };
}

export function goToRefPath(pid: string, id: string): string {
  return `/p/${pid}/go/${encodeURIComponent(id)}`;
}

/** 消息所在页面 + `#msg_…`：时间线 / 线程 / 个人会话 */
export function messagePath(
  pid: string,
  messageId: string,
  thread: Pick<Thread, 'id' | 'kind'> | null,
  agentVisible = true,
): string {
  const discussion =
    !agentVisible && thread?.kind !== 'personal' ? `?discussion=${thread?.id ?? 'project'}` : '';
  if (!thread) return `/p/${pid}${discussion}#${messageId}`;
  const section = thread.kind === 'personal' ? 'workspace' : 'threads';
  return `/p/${pid}/${section}/${thread.id}${discussion}#${messageId}`;
}

export interface RefFetcher {
  message: (
    id: string,
  ) => Promise<Pick<Message, 'id' | 'threadId'> & Partial<Pick<Message, 'agentVisible'>>>;
  decision: (id: string) => Promise<Pick<Decision, 'messageId' | 'threadId'>>;
  thread: (id: string) => Promise<Pick<Thread, 'id' | 'kind'>>;
}

/** 查出引用的真实地址。查不到时抛出（由调用方提示）。 */
export async function resolveRefPath(pid: string, ref: string, f: RefFetcher): Promise<string> {
  const parsed = parseLinkRef(ref);
  if (!parsed) throw new Error(tr('认不出的引用：{ref}', { ref }));
  let agentVisible = true;
  let messageId: string;
  let threadId: string | null;
  if (parsed.kind === 'message') {
    const m = await f.message(parsed.id);
    agentVisible = m.agentVisible !== false;
    messageId = m.id;
    threadId = m.threadId;
  } else {
    const d = await f.decision(parsed.id);
    messageId = d.messageId;
    threadId = d.threadId;
  }
  const thread = threadId ? await f.thread(threadId) : null;
  return messagePath(pid, messageId, thread, agentVisible);
}

/** 当前页面上代表这条引用的元素（消息本身，或决策卡所在的消息）。 */
export function findRefElement(ref: string): HTMLElement | null {
  const parsed = parseLinkRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'message') return document.getElementById(parsed.id);
  const card = document.querySelector<HTMLElement>(`[data-decision-id="${CSS.escape(parsed.id)}"]`);
  return card?.closest<HTMLElement>('article[id^="msg_"]') ?? card;
}

export const FLASH_MS = 1800;

/** 滚到元素并短暂高亮（data-flash，样式在 MessageItem 上）。 */
export function flashElement(el: HTMLElement, reducedMotion = false): void {
  el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  el.setAttribute('data-flash', '');
  window.setTimeout(() => el.removeAttribute('data-flash'), FLASH_MS);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
