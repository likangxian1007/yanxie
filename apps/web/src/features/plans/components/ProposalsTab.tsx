import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Check, Inbox, X } from 'lucide-react';
import {
  BASIS_PROPOSAL_KIND_LABEL,
  type BasisProposal,
  type BasisProposalStatus,
  type Plan,
} from '@srh/shared';
import { Badge, Button, EmptyState, RelativeTime, Tabs, Textarea, toast } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { useDecideProposal, usePlanVersions, useProposalAction } from '../api';
import { PlanDiff } from './PlanDiff';
import {
  ClaimBadge,
  EvidenceList,
  Field,
  ProposalStatusBadge,
  TextBlock,
  errorText,
} from './shared';
import { tr, trServer } from '@/lib/i18n';

type Filter = 'open' | 'mine' | 'closed';

export interface ProposalsTabProps {
  pid: string;
  proposals: BasisProposal[];
  official: Plan | null;
  canManage: boolean;
  meId: string | undefined;
  /** 受控的选中提案（深链 ?proposal=） */
  openId: string | null;
  onOpenIdChange: (id: string | null) => void;
}

const CLOSED: BasisProposalStatus[] = ['accepted', 'rejected', 'withdrawn'];

export function ProposalsTab({
  pid,
  proposals,
  official,
  canManage,
  meId,
  openId,
  onOpenIdChange,
}: ProposalsTabProps) {
  const [filter, setFilter] = useState<Filter>('open');
  const { variants, stagger } = useMotionPreset();

  const sorted = useMemo(
    () => proposals.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [proposals],
  );
  const groups = useMemo(
    () => ({
      open: sorted.filter((p) => p.status === 'submitted'),
      mine: sorted.filter((p) => p.authorId === meId && p.status === 'draft'),
      closed: sorted.filter((p) => CLOSED.includes(p.status)),
    }),
    [sorted, meId],
  );

  const open = proposals.find((p) => p.id === openId);
  if (open) {
    return (
      <ProposalDetail
        pid={pid}
        proposal={open}
        official={official}
        canManage={canManage}
        isAuthor={open.authorId === meId}
        onBack={() => onOpenIdChange(null)}
      />
    );
  }

  const list = groups[filter];
  return (
    <div className="flex flex-col gap-3">
      <Tabs
        variant="segmented"
        size="sm"
        layoutId="plans-proposal-filter"
        aria-label={tr('提案筛选')}
        value={filter}
        onValueChange={setFilter}
        items={[
          { value: 'open', label: tr('待审批'), count: groups.open.length },
          { value: 'mine', label: tr('我的草稿'), count: groups.mine.length },
          { value: 'closed', label: tr('已处理') },
        ]}
      />
      {list.length === 0 ? (
        <EmptyState
          framed
          icon={Inbox}
          tone="agent"
          title={
            filter === 'open'
              ? tr('没有待审批的提案')
              : filter === 'mine'
                ? tr('你没有草稿')
                : tr('还没有处理过的提案')
          }
          description={tr('在探索副本里点“提交为提案”，或在我的记忆里整理为团队依据提案。')}
        />
      ) : (
        <motion.ul
          key={filter}
          variants={stagger()}
          initial="hidden"
          animate="visible"
          className="research-list"
          aria-label={tr('提案')}
        >
          {list.map((p) => (
            <motion.li key={p.id} variants={variants.fadeUp} className="research-row">
              <button
                type="button"
                onClick={() => onOpenIdChange(p.id)}
                className="flex min-h-11 w-full cursor-pointer flex-col gap-1 px-3 py-2.5 text-left hover:bg-subtle"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-small font-medium text-fg">
                    {p.title}
                  </span>
                  <ProposalStatusBadge status={p.status} />
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-subtle">
                  <Badge tone={p.kind === 'plan_change' ? 'accent' : 'agent'}>
                    {BASIS_PROPOSAL_KIND_LABEL[p.kind]}
                  </Badge>
                  <ClaimBadge type={p.claimType} />
                  <span>{trServer(p.draftedBy.name)}</span>
                  <RelativeTime iso={p.submittedAt ?? p.updatedAt} />
                </span>
              </button>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}

function ProposalDetail({
  pid,
  proposal: p,
  official,
  canManage,
  isAuthor,
  onBack,
}: {
  pid: string;
  proposal: BasisProposal;
  official: Plan | null;
  canManage: boolean;
  isAuthor: boolean;
  onBack: () => void;
}) {
  const [note, setNote] = useState('');
  const decide = useDecideProposal(pid);
  const action = useProposalAction(pid);
  const isPlan = p.kind === 'plan_change';
  const versions = usePlanVersions(pid, isPlan ? official?.id : undefined);

  // 对比的基线：提案基于的正式版本；版本列表没取到时退回当前正式方案
  const base =
    versions.data?.find((v) => v.version === p.basePlanVersion)?.content ??
    (p.basePlanVersion === null || p.basePlanVersion === official?.version
      ? (official?.content ?? '')
      : null);
  const stale =
    isPlan &&
    p.status === 'submitted' &&
    official !== null &&
    p.basePlanVersion !== null &&
    p.basePlanVersion < official.version;

  const run = (decision: 'accept' | 'reject') =>
    decide.mutate(
      { id: p.id, decision, note },
      {
        onSuccess: () =>
          toast({
            title: decision === 'accept' ? tr('已采纳提案') : tr('已退回提案'),
            tone: decision === 'accept' ? 'success' : 'info',
          }),
        onError: (e) =>
          toast({
            title: errorText(e, decision === 'accept' ? tr('采纳') : tr('退回')),
            tone: 'danger',
          }),
      },
    );

  const doAction = (kind: 'submit' | 'withdraw') =>
    action.mutate(
      { id: p.id, action: kind },
      {
        onSuccess: () =>
          toast({
            title: kind === 'submit' ? tr('提案已提交') : tr('提案已撤回'),
            tone: 'success',
          }),
        onError: (e) =>
          toast({
            title: errorText(e, kind === 'submit' ? tr('提交') : tr('撤回')),
            tone: 'danger',
          }),
      },
    );

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <div>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<ArrowLeft strokeWidth={1.75} aria-hidden />}
          onClick={onBack}
        >
          {tr('返回列表')}
        </Button>
      </div>
      <header className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isPlan ? 'accent' : 'agent'}>{BASIS_PROPOSAL_KIND_LABEL[p.kind]}</Badge>
          <ClaimBadge type={p.claimType} />
          <ProposalStatusBadge status={p.status} />
        </div>
        <h2 className="mt-2 text-h3 break-words text-fg">{p.title}</h2>
        <p className="mt-1 text-caption text-fg-subtle">
          {trServer(p.draftedBy.name)}
          {tr(' 起草 · ')}
          <RelativeTime iso={p.submittedAt ?? p.createdAt} />
          {isPlan && p.basePlanVersion !== null && (
            <span className="tabular-nums">
              {tr(' · 基于正式方案第 {basePlanVersion} 版', { basePlanVersion: p.basePlanVersion })}
            </span>
          )}
        </p>
      </header>

      {stale && (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-small text-warning">
          {tr(
            '正式方案已更新到第 {version} 版，这个提案基于第 {basePlanVersion}{value}版，采纳前请确认改动仍然适用。',
            { version: official.version, basePlanVersion: p.basePlanVersion, value: ' ' },
          )}
        </p>
      )}

      <Field label={tr('理由')}>
        <TextBlock text={p.rationale} />
      </Field>
      <Field label={tr('已知影响')}>
        <TextBlock text={p.impact} empty={tr('没有写已知影响')} />
      </Field>
      {!isPlan && (
        <Field label={tr('成立条件')}>
          <TextBlock text={p.conditions} empty={tr('没有写条件')} />
        </Field>
      )}

      <Field label={isPlan ? tr('改动') : tr('依据内容')}>
        {isPlan ? (
          base === null ? (
            versions.isPending ? (
              <p className="text-small text-fg-subtle">{tr('正在加载基线版本…')}</p>
            ) : (
              <PlanDiff
                before={official?.content ?? ''}
                after={p.content}
                caption={tr('相对当前正式方案')}
              />
            )
          ) : (
            <PlanDiff
              before={base}
              after={p.content}
              caption={
                p.basePlanVersion !== null
                  ? tr('相对第 {basePlanVersion} 版', { basePlanVersion: p.basePlanVersion })
                  : undefined
              }
            />
          )
        ) : (
          <TextBlock text={p.content} />
        )}
      </Field>

      <Field label={tr('证据')}>
        <EvidenceList evidence={p.evidence} />
      </Field>

      {p.decidedAt && (
        <Field label={tr('审批结果')}>
          <p className="text-small text-fg">
            {p.decidedBy ? trServer(p.decidedBy.name) : tr('负责人')} ·{' '}
            <RelativeTime iso={p.decidedAt} />
            {p.resultPlanVersion !== null && (
              <span className="tabular-nums">
                {tr(' · 成为正式方案第 {resultPlanVersion} 版', {
                  resultPlanVersion: p.resultPlanVersion,
                })}
              </span>
            )}
          </p>
          {p.decisionNote && (
            <p className="mt-1 text-small break-words whitespace-pre-wrap text-fg-muted">
              {p.decisionNote}
            </p>
          )}
        </Field>
      )}

      {isAuthor && (p.status === 'draft' || p.status === 'submitted') && (
        <div className="flex flex-wrap gap-2">
          {p.status === 'draft' && (
            <Button variant="primary" loading={action.isPending} onClick={() => doAction('submit')}>
              {tr('提交审批')}
            </Button>
          )}
          <Button
            variant="secondary"
            loading={action.isPending}
            onClick={() => doAction('withdraw')}
          >
            {tr('撤回提案')}
          </Button>
        </div>
      )}

      {canManage && p.status === 'submitted' && (
        <section
          aria-label={tr('审批')}
          className="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:static md:mx-0 md:rounded-lg md:border md:p-4"
        >
          <Textarea
            aria-label={tr('审批意见')}
            rows={2}
            placeholder={tr('审批意见（可选），会通知提案人')}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button
              size="lg"
              variant="danger"
              disabled={decide.isPending}
              leftIcon={<X strokeWidth={1.75} aria-hidden />}
              onClick={() => run('reject')}
            >
              {tr('不采纳')}
            </Button>
            <Button
              size="lg"
              variant="primary"
              loading={decide.isPending}
              leftIcon={<Check strokeWidth={1.75} aria-hidden />}
              onClick={() => run('accept')}
            >
              {tr('采纳')}
            </Button>
          </div>
        </section>
      )}
    </article>
  );
}
