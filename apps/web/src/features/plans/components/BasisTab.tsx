import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, BookCheck, Check, ChevronDown, CircleSlash } from 'lucide-react';
import type { TeamBasis } from '@srh/shared';
import { Button, EmptyState, RelativeTime, Tabs, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useReviewBasis } from '../api';
import { BasisStatusBadge, ClaimBadge, EvidenceList, Field, TextBlock, errorText } from './shared';
import { tr, trServer } from '@/lib/i18n';

type Filter = 'current' | 'review' | 'all';

export interface BasisTabProps {
  pid: string;
  basis: TeamBasis[];
  canManage: boolean;
}

/** 团队依据：每条带类型、提出与批准人、条件、证据版本和所依据的方案版本；待复核的高亮 */
export function BasisTab({ pid, basis, canManage }: BasisTabProps) {
  const needsReview = basis.filter((b) => b.status === 'needs_review');
  const [filter, setFilter] = useState<Filter>(needsReview.length > 0 ? 'review' : 'current');
  const { variants, stagger } = useMotionPreset();

  const list = useMemo(() => {
    const sorted = basis.slice().sort((a, b) => {
      // 待复核排最前
      const r = Number(b.status === 'needs_review') - Number(a.status === 'needs_review');
      return r || b.updatedAt.localeCompare(a.updatedAt);
    });
    if (filter === 'review') return sorted.filter((b) => b.status === 'needs_review');
    if (filter === 'current')
      return sorted.filter((b) => b.status === 'active' || b.status === 'needs_review');
    return sorted;
  }, [basis, filter]);

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        variant="segmented"
        size="sm"
        layoutId="plans-basis-filter"
        aria-label={tr('依据筛选')}
        value={filter}
        onValueChange={setFilter}
        items={[
          { value: 'current', label: tr('有效') },
          { value: 'review', label: tr('待复核'), count: needsReview.length },
          { value: 'all', label: tr('全部') },
        ]}
      />
      {list.length === 0 ? (
        <EmptyState
          framed
          icon={BookCheck}
          tone="agent"
          title={filter === 'review' ? tr('没有需要复核的依据') : tr('还没有团队依据')}
          description={tr('团队依据来自获批的提案。可以在我的记忆里整理后提交。')}
        />
      ) : (
        <motion.ul
          key={filter}
          variants={stagger()}
          initial="hidden"
          animate="visible"
          className="research-list"
          aria-label={tr('团队依据')}
        >
          {list.map((b) => (
            <motion.li key={b.id} variants={variants.fadeUp} className="research-row">
              <BasisRow pid={pid} basis={b} canManage={canManage} />
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}

function BasisRow({
  pid,
  basis: b,
  canManage,
}: {
  pid: string;
  basis: TeamBasis;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(b.status === 'needs_review');
  const review = useReviewBasis(pid);
  const flagged = b.status === 'needs_review';
  const inactive = b.status === 'superseded' || b.status === 'retired';

  const act = (action: 'confirm' | 'retire') =>
    review.mutate(
      { id: b.id, action, note: '' },
      {
        onSuccess: () =>
          toast({
            title: action === 'confirm' ? tr('已确认依据仍然有效') : tr('已停用这条依据'),
            tone: 'success',
          }),
        onError: (e) =>
          toast({
            title: errorText(e, action === 'confirm' ? tr('确认') : tr('停用')),
            tone: 'danger',
          }),
      },
    );

  return (
    <div className={cn('min-w-0', flagged && 'border-l-2 border-warning bg-warning-soft/40')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <ClaimBadge type={b.claimType} />
            <span
              className={cn(
                'min-w-0 text-small font-medium break-words text-fg',
                inactive && 'text-fg-muted line-through',
              )}
            >
              {b.title}
            </span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-subtle">
            <BasisStatusBadge status={b.status} />
            <span>
              {tr('{name} 提出 · {name2} 批准', {
                name: b.proposer.name,
                name2: trServer(b.approvedBy.name),
              })}
            </span>
            {b.planVersion !== null && (
              <span className="tabular-nums">
                {tr('方案第 {planVersion} 版', { planVersion: b.planVersion })}
              </span>
            )}
            <RelativeTime iso={b.updatedAt} />
          </span>
        </span>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={cn(
            'mt-0.5 shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {flagged && (
            <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-small text-warning">
              <AlertTriangle size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
              <span>
                {b.reviewReason ||
                  tr('相关的方案或证据有变化，需要负责人确认这条依据是否仍然成立。')}
              </span>
            </p>
          )}
          <TextBlock text={b.content} />
          <Field label={tr('成立条件')}>
            <TextBlock text={b.conditions} empty={tr('没有写条件')} />
          </Field>
          <Field label={tr('证据')}>
            <EvidenceList evidence={b.evidence} />
          </Field>
          {canManage && (b.status === 'active' || flagged) && (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button
                variant="secondary"
                disabled={review.isPending}
                leftIcon={<CircleSlash strokeWidth={1.75} aria-hidden />}
                onClick={() => act('retire')}
              >
                {tr('停用依据')}
              </Button>
              <Button
                variant={flagged ? 'primary' : 'secondary'}
                loading={review.isPending}
                leftIcon={<Check strokeWidth={1.75} aria-hidden />}
                onClick={() => act('confirm')}
              >
                {tr('确认有效')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
