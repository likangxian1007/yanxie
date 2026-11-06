import type { ReactNode } from 'react';
import {
  BASIS_CLAIM_TYPE_LABEL,
  BASIS_EVIDENCE_KIND_LABEL,
  BASIS_PROPOSAL_STATUS_LABEL,
  TEAM_BASIS_STATUS_LABEL,
  type BasisClaimType,
  type BasisEvidence,
  type BasisProposalStatus,
  type TeamBasisStatus,
} from '@srh/shared';
import { Badge, Button, type BadgeTone } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { tr } from '@/lib/i18n';

export const CLAIM_TONE: Record<BasisClaimType, BadgeTone> = {
  hypothesis: 'warning',
  observation: 'accent',
  decision: 'success',
};

export function ClaimBadge({ type }: { type: BasisClaimType | null | undefined }) {
  if (!type) return null;
  return <Badge tone={CLAIM_TONE[type]}>{BASIS_CLAIM_TYPE_LABEL[type]}</Badge>;
}

const PROPOSAL_TONE: Record<BasisProposalStatus, BadgeTone> = {
  draft: 'neutral',
  submitted: 'warning',
  accepted: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
};

export function ProposalStatusBadge({ status }: { status: BasisProposalStatus }) {
  return (
    <Badge tone={PROPOSAL_TONE[status]} dot>
      {BASIS_PROPOSAL_STATUS_LABEL[status]}
    </Badge>
  );
}

const BASIS_TONE: Record<TeamBasisStatus, BadgeTone> = {
  active: 'success',
  needs_review: 'warning',
  superseded: 'neutral',
  retired: 'neutral',
};

export function BasisStatusBadge({ status }: { status: TeamBasisStatus }) {
  return (
    <Badge tone={BASIS_TONE[status]} dot>
      {TEAM_BASIS_STATUS_LABEL[status]}
    </Badge>
  );
}

/** 证据列表：类型 · 名称 · 固定版本 · 摘录 */
export function EvidenceList({ evidence }: { evidence: BasisEvidence[] }) {
  if (evidence.length === 0) return <p className="text-small text-fg-subtle">{tr('没有附证据')}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {evidence.map((e, i) => (
        <li key={i} className="min-w-0 rounded-md border border-line bg-subtle px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small">
            <Badge>{BASIS_EVIDENCE_KIND_LABEL[e.kind]}</Badge>
            {e.kind === 'link' && /^https?:\/\//u.test(e.ref) ? (
              <a
                href={e.ref}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 break-all text-accent-text underline-offset-2 hover:underline"
              >
                {e.label || e.ref}
              </a>
            ) : (
              <span className="min-w-0 break-all text-fg">{e.label || e.ref}</span>
            )}
            {e.version && (
              <span className="text-caption text-fg-subtle tabular-nums">
                {tr('版本 {version}', { version: e.version })}
              </span>
            )}
          </div>
          {e.excerpt && (
            <p className="mt-1 text-small break-words whitespace-pre-wrap text-fg-muted">
              {e.excerpt}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 详情里的一组“标题 + 内容” */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1 text-caption text-fg-subtle">{label}</h4>
      {children}
    </section>
  );
}

export function TextBlock({ text, empty = tr('未填写') }: { text: string; empty?: string }) {
  return text.trim() ? (
    <p className="text-small break-words whitespace-pre-wrap text-fg">{text}</p>
  ) : (
    <p className="text-small text-fg-subtle">{empty}</p>
  );
}

/** 把接口错误翻成“发生了什么 + 怎么办” */
export function errorText(err: unknown, action: string): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 409)
      return tr('{action}没有成功：内容已被别人更新，请刷新后再改。', { action });
    if (err.status === 403) return tr('{action}没有成功：你没有这个操作的权限。', { action });
    if (err.status === 404)
      return tr('{action}没有成功：接口或对象不存在，请刷新页面后再试。', { action });
    if (err.status === 0) return tr('{action}没有成功：网络断开了，恢复后再试。', { action });
    return tr('{action}没有成功：{message}', { action, message: err.message });
  }
  return tr('{action}没有成功，请稍后再试。', { action });
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-danger-soft p-4 text-small text-danger">
      <p>{message}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {tr('重试')}
      </Button>
    </div>
  );
}
