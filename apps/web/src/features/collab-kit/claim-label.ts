import type { WorkClaim } from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 认领对象的可读名字（文档 / 章节）。
 *
 * resourceRef 约定（ARCHITECTURE §5.3）：document = `doc_xxx`，doc_section = `doc_xxx#<标题原文>`；
 * 也兼容带类型前缀的写法（`doc:doc_xxx#…`）。界面上不要直接显示原始 id，
 * 用这里的函数换成「《文档标题》· 章节」。
 */
export interface DocClaimRef {
  docId: string;
  /** 章节标题原文；整篇文档认领时为 null */
  section: string | null;
}

export function parseDocClaimRef(
  claim: Pick<WorkClaim, 'resourceKind' | 'resourceRef'>,
): DocClaimRef | null {
  if (claim.resourceKind !== 'document' && claim.resourceKind !== 'doc_section') return null;
  const ref = claim.resourceRef.trim().replace(/^[a-z_]+:(?=doc_)/u, '');
  const hash = ref.indexOf('#');
  const docId = (hash < 0 ? ref : ref.slice(0, hash)).trim();
  if (!docId) return null;
  const section = hash < 0 ? null : ref.slice(hash + 1).trim() || null;
  return { docId, section: claim.resourceKind === 'doc_section' ? section : null };
}

/** 「《标题》· 章节」；找不到标题时用「这篇文档」兜底，不显示原始 id */
export function docClaimLabel(ref: DocClaimRef, docTitle: string | null | undefined): string {
  const title = docTitle?.trim()
    ? tr('《{docTitle}》', { docTitle: docTitle.trim() })
    : tr('这篇文档');
  if (!ref.section) return title;
  // 书名号自带间距，后面不再加空格
  return title.endsWith('》') ? `${title}· ${ref.section}` : `${title} · ${ref.section}`;
}

/**
 * 认领人的显示名：agent 认领时写成「张三的 agent」（onBehalfOfUserId 对应的成员），
 * 找不到代表的人时退回 holder.name。
 */
export function claimHolderLabel(
  claim: Pick<WorkClaim, 'holder' | 'onBehalfOfUserId'>,
  nameOf: (userId: string) => string | undefined,
): string {
  if (claim.holder.kind !== 'agent') return claim.holder.name;
  const owner = claim.onBehalfOfUserId ? nameOf(claim.onBehalfOfUserId) : undefined;
  return owner ? tr('{owner}的 agent', { owner }) : claim.holder.name;
}
