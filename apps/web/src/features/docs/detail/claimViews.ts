import type { DocumentOutlineItem, WorkClaim } from '@srh/shared';
import {
  claimHolderLabel,
  docClaimLabel,
  parseDocClaimRef,
  type DocClaimRef,
} from '@/features/collab-kit/claim-label';
import { tr } from '@/lib/i18n';

export interface DocClaimView {
  claim: WorkClaim;
  ref: DocClaimRef;
  /** 交给 ClaimBadge 渲染的副本：holder 名字换成「张三的 agent」，resourceRef 换成可读的章节名 */
  display: WorkClaim;
  /** 章节在大纲里的下标（找不到为 -1） */
  outlineIndex: number;
}

/** 当前有效、且落在这篇文档（整篇或某一节）上的认领；agent 的排在前面 */
export function claimsForDoc(
  claims: readonly WorkClaim[],
  docId: string,
  now: number = Date.now(),
): { claim: WorkClaim; ref: DocClaimRef }[] {
  const out: { claim: WorkClaim; ref: DocClaimRef }[] = [];
  for (const claim of claims) {
    if (claim.status !== 'active') continue;
    const expires = Date.parse(claim.expiresAt);
    if (Number.isFinite(expires) && expires <= now) continue;
    const ref = parseDocClaimRef(claim);
    if (!ref || ref.docId !== docId) continue;
    out.push({ claim, ref });
  }
  return out.sort(
    (a, b) =>
      Number(b.claim.holder.kind === 'agent') - Number(a.claim.holder.kind === 'agent') ||
      a.claim.createdAt.localeCompare(b.claim.createdAt),
  );
}

/** 章节标题 → 大纲下标：先比原文，再忽略编号和空白比 */
export function findOutlineIndex(outline: readonly DocumentOutlineItem[], section: string): number {
  const norm = (s: string) =>
    s
      .replace(/^[\d.\s]+/u, '')
      .replace(/\s+/gu, '')
      .toLowerCase();
  const exact = outline.findIndex((o) => o.heading.trim() === section.trim());
  if (exact >= 0) return exact;
  const target = norm(section);
  if (!target) return -1;
  return outline.findIndex((o) => norm(o.heading) === target);
}

export function toDocClaimViews(
  claims: readonly WorkClaim[],
  docId: string,
  docTitle: string,
  outline: readonly DocumentOutlineItem[],
  nameOf: (userId: string) => string | undefined,
  now: number = Date.now(),
): DocClaimView[] {
  return claimsForDoc(claims, docId, now).map(({ claim, ref }) => {
    const target = ref.section
      ? tr('「{section}」', { section: ref.section })
      : docClaimLabel(ref, docTitle);
    return {
      claim,
      ref,
      display: {
        ...claim,
        holder: { ...claim.holder, name: claimHolderLabel(claim, nameOf) },
        // ClaimBadge 用 claimTarget() 显示「<类型> <ref>」，这里把原始 id 换成可读名字
        resourceRef: target,
      },
      outlineIndex: ref.section ? findOutlineIndex(outline, ref.section) : -1,
    };
  });
}
