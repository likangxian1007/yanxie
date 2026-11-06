import type { OutputRef } from '@srh/shared';
import { withBase } from './base-path';
import { goToRefPath, parseLinkRef } from './message-link';

/**
 * 站内引用（agent 在正文或产出里写的 id）→ 前端路由。
 * - thr_… → 线程（个人会话会在线程页自动跳到工作区）
 * - msg_… / dec_… → 跳转页 /p/:pid/go/:id，查出消息（决策卡）在时间线还是哪个线程再跳过去；
 *   消息就在当前页面上时，Markdown 链接会直接滚过去（见 lib/message-link.ts）
 * - doc_ / exp_ / rpt_ → 对应协作页
 * 认不出来时返回 null。
 */
export function internalHref(pid: string, ref: string): string | null {
  const id = ref.replace(/^#/u, '');
  if (id.startsWith('thr_')) return `/p/${pid}/threads/${id}`;
  if (parseLinkRef(id)) return goToRefPath(pid, id);
  if (id.startsWith('doc_')) return `/p/${pid}/docs/${id.split('#')[0]}`;
  if (id.startsWith('exp_')) return `/p/${pid}/experiments/${id}`;
  if (id.startsWith('rpt_')) return `/p/${pid}/reports/${id}`;
  if (id.startsWith('rrc_')) return `/p/${pid}/research/${id}`;
  if (id.startsWith('rsr_')) return `/p/${pid}/research-sources/${id}`;
  if (id.startsWith('rwi_')) return `/p/${pid}/research-items/${id}`;
  // 改动提案：提案页会跳到它的审阅
  if (id.startsWith('cp_')) return `/p/${pid}/proposals/${id}`;
  return null;
}

export function outputHref(pid: string, o: OutputRef): { href: string; external: boolean } {
  switch (o.kind) {
    case 'link': {
      if (/^https?:/u.test(o.ref)) return { href: o.ref, external: true };
      return { href: internalHref(pid, o.ref) ?? `#${o.ref}`, external: false };
    }
    case 'file':
      return {
        href: withBase(`/api/v1/projects/${pid}/files/${o.ref}?download=1`),
        external: true,
      };
    case 'document':
      return { href: `/p/${pid}/docs/${o.ref}`, external: false };
    case 'experiment':
      return { href: `/p/${pid}/experiments/${o.ref}`, external: false };
    case 'report':
      return { href: `/p/${pid}/reports/${o.ref}`, external: false };
    case 'research':
      return { href: `/p/${pid}/research/${o.ref}`, external: false };
  }
}
