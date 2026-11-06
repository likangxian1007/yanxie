import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  BASIS_CLAIM_TYPE_LABEL,
  BASIS_EVIDENCE_KIND_LABEL,
  BasisClaimType,
  BasisEvidenceKind,
  BASIS_PROPOSAL_KIND_LABEL,
  type BasisEvidence,
  type BasisProposal,
  type BasisProposalKind,
} from '@srh/shared';
import { Button, Dialog, IconButton, Input, Select, Textarea, toast } from '@/components/ui';
import { useCreateProposal } from '../api';
import { errorText } from './shared';
import { tr } from '@/lib/i18n';

export interface ProposalDraft {
  kind: BasisProposalKind;
  title: string;
  content: string;
  rationale: string;
  impact: string;
  conditions: string;
  claimType?: BasisClaimType | undefined;
  evidence: BasisEvidence[];
  sourcePlanId?: string | undefined;
  basePlanVersion?: number | undefined;
}

export interface ProposalFormDialogProps {
  pid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ProposalDraft;
  /** 对话框说明 */
  description?: string;
  onCreated?: (proposal: BasisProposal) => void;
}

/**
 * 提案表单：plan_change（探索副本提交为修改正式方案）与 team_basis（纳入团队依据）共用。
 * 必填理由；已知影响、证据可选。用 key 重新挂载来重置。
 */
export function ProposalFormDialog({
  pid,
  open,
  onOpenChange,
  initial,
  description,
  onCreated,
}: ProposalFormDialogProps) {
  const [draft, setDraft] = useState<ProposalDraft>(initial);
  const [touched, setTouched] = useState(false);
  const create = useCreateProposal(pid);
  const isBasis = draft.kind === 'team_basis';
  const set = <K extends keyof ProposalDraft>(k: K, v: ProposalDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const titleError = touched && !draft.title.trim() ? tr('写一个标题') : undefined;
  const rationaleError = touched && !draft.rationale.trim() ? tr('写下为什么要这样改') : undefined;
  const contentError =
    touched && isBasis && !draft.content.trim() ? tr('写下要纳入的依据内容') : undefined;
  const evidenceInvalid = draft.evidence.some((e) => !e.ref.trim());

  const save = (submit: boolean) => {
    setTouched(true);
    if (!draft.title.trim() || !draft.rationale.trim() || (isBasis && !draft.content.trim()))
      return;
    if (evidenceInvalid) return;
    create.mutate(
      {
        kind: draft.kind,
        title: draft.title.trim(),
        content: draft.content,
        rationale: draft.rationale,
        impact: draft.impact,
        conditions: draft.conditions,
        evidence: draft.evidence.map((e) => ({
          ...e,
          ref: e.ref.trim(),
          ...(e.version?.trim() ? { version: e.version.trim() } : { version: undefined }),
        })),
        submit,
        ...(isBasis && draft.claimType ? { claimType: draft.claimType } : {}),
        ...(draft.sourcePlanId ? { sourcePlanId: draft.sourcePlanId } : {}),
        ...(draft.basePlanVersion !== undefined ? { basePlanVersion: draft.basePlanVersion } : {}),
      },
      {
        onSuccess: (p) => {
          toast({
            title: submit ? tr('提案已提交，等待负责人审批') : tr('提案已存为草稿'),
            tone: 'success',
          });
          onOpenChange(false);
          onCreated?.(p);
        },
        onError: (e) =>
          toast({ title: errorText(e, submit ? tr('提交提案') : tr('保存草稿')), tone: 'danger' }),
      },
    );
  };

  const updateEvidence = (i: number, patch: Partial<BasisEvidence>) =>
    set(
      'evidence',
      draft.evidence.map((e, j) => (j === i ? { ...e, ...patch } : e)),
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={BASIS_PROPOSAL_KIND_LABEL[draft.kind]}
      description={description}
      footer={
        <>
          <Button variant="ghost" disabled={create.isPending} onClick={() => save(false)}>
            {tr('存为草稿')}
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => save(true)}>
            {tr('提交提案')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save(true);
        }}
      >
        <Labeled label={tr('标题')}>
          <Input
            value={draft.title}
            maxLength={200}
            error={titleError}
            onChange={(e) => set('title', e.target.value)}
          />
        </Labeled>
        {isBasis && (
          <>
            <Labeled label={tr('类型')}>
              <Select
                value={draft.claimType ?? 'hypothesis'}
                onChange={(e) => set('claimType', e.target.value as BasisClaimType)}
              >
                {BasisClaimType.options.map((t) => (
                  <option key={t} value={t}>
                    {BASIS_CLAIM_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label={tr('依据内容')}>
              <Textarea
                rows={5}
                autoGrow
                value={draft.content}
                error={contentError}
                onChange={(e) => set('content', e.target.value)}
              />
            </Labeled>
            <Labeled
              label={tr('成立条件')}
              hint={tr('在什么前提下这条依据成立，例如数据集、参数范围')}
            >
              <Textarea
                rows={2}
                autoGrow
                value={draft.conditions}
                onChange={(e) => set('conditions', e.target.value)}
              />
            </Labeled>
          </>
        )}
        <Labeled label={tr('理由')}>
          <Textarea
            rows={3}
            autoGrow
            value={draft.rationale}
            error={rationaleError}
            placeholder={tr('为什么要这样改')}
            onChange={(e) => set('rationale', e.target.value)}
          />
        </Labeled>
        <Labeled label={tr('已知影响')} hint={tr('会影响哪些实验、结论或分工')}>
          <Textarea
            rows={2}
            autoGrow
            value={draft.impact}
            onChange={(e) => set('impact', e.target.value)}
          />
        </Labeled>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-small font-medium text-fg">{tr('证据')}</legend>
          {draft.evidence.length === 0 && (
            <p className="text-small text-fg-subtle">
              {tr('还没有证据。可以附实验记录、文档、文献或链接。')}
            </p>
          )}
          {draft.evidence.map((e, i) => (
            <div
              key={i}
              className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-subtle p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Select
                  aria-label={tr('证据类型')}
                  wrapperClassName="min-w-0 flex-1"
                  value={e.kind}
                  onChange={(ev) =>
                    updateEvidence(i, { kind: ev.target.value as BasisEvidenceKind })
                  }
                >
                  {BasisEvidenceKind.options
                    .filter((k) => k !== 'experiment')
                    .map((k) => (
                      <option key={k} value={k}>
                        {BASIS_EVIDENCE_KIND_LABEL[k]}
                      </option>
                    ))}
                </Select>
                <IconButton
                  label={tr('移除证据')}
                  onClick={() =>
                    set(
                      'evidence',
                      draft.evidence.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 strokeWidth={1.75} aria-hidden />
                </IconButton>
              </div>
              <Input
                aria-label={tr('证据标识')}
                placeholder={tr('链接、ID 或路径')}
                value={e.ref}
                maxLength={500}
                error={touched && !e.ref.trim() ? tr('填写证据标识') : undefined}
                onChange={(ev) => updateEvidence(i, { ref: ev.target.value })}
              />
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                <Input
                  aria-label={tr('证据名称')}
                  placeholder={tr('名称（可选）')}
                  value={e.label}
                  maxLength={200}
                  onChange={(ev) => updateEvidence(i, { label: ev.target.value })}
                />
                <Input
                  aria-label={tr('证据版本')}
                  placeholder={tr('版本（可选）')}
                  value={e.version ?? ''}
                  onChange={(ev) => updateEvidence(i, { version: ev.target.value })}
                />
              </div>
              <Textarea
                aria-label={tr('摘录')}
                rows={2}
                placeholder={tr('摘录或关键数据（可选）')}
                value={e.excerpt ?? ''}
                maxLength={2000}
                onChange={(ev) => updateEvidence(i, { excerpt: ev.target.value })}
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
              disabled={draft.evidence.length >= 50}
              onClick={() =>
                set('evidence', [...draft.evidence, { kind: 'document', ref: '', label: '' }])
              }
            >
              {tr('添加证据')}
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-small font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="text-caption text-fg-subtle">{hint}</span>}
    </label>
  );
}
