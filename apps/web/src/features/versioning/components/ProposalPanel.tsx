import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CircleCheck,
  GitMerge,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import type { ChangeProposal, HunkDecision, ProposalHunk } from '@srh/shared';
import {
  Badge,
  Button,
  Dialog,
  Markdown,
  RelativeTime,
  Skeleton,
  Tooltip,
  toast,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import {
  useCloseProposal,
  useMergeProposal,
  useProposal,
  useProposalDecisions,
  useVersioningEvents,
} from '../api';
import { CellChange, NotebookCellDiff } from './ContentDiff';
import { tr, trServer } from '@/lib/i18n';

const DOC_KIND_NOUN: Record<string, string> = {
  doc: tr('文档'),
  sheet: tr('表格'),
  latex: tr('LaTeX 文档'),
  slides: tr('幻灯片'),
};

function proposalTargetHref(pid: string, p: ChangeProposal): string | null {
  // notebook 的页面入口在它所属的实验里；没挂实验的 notebook 没有独立页面
  if (p.targetKind === 'notebook') {
    return `/p/${pid}/notebooks/${p.targetId}`;
  }
  return `/p/${pid}/docs/${p.targetId}`;
}

/**
 * 改动提案的审阅视图（嵌在审阅详情的「改动」页签）：
 * 逐条接受 / 拒绝，标出和正文冲突的改动，合入已接受的，或 LGTM 后整体合入。
 */
export function ProposalPanel({
  pid,
  proposalId,
  writable,
  isReviewer,
}: {
  pid: string;
  proposalId: string;
  writable: boolean;
  /** 当前用户是这条审阅的审阅人：主按钮是「LGTM 并合入」 */
  isReviewer: boolean;
}) {
  useVersioningEvents(pid);
  const q = useProposal(pid, proposalId);
  if (q.isPending) {
    return (
      <div role="status" aria-label={tr('正在加载改动')} className="flex flex-col gap-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="flex items-center gap-3 rounded-md bg-danger-soft px-3 py-2.5 text-small text-danger">
        <AlertTriangle size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1">
          {tr('改动提案没有加载出来：')}
          {q.error instanceof ApiRequestError ? q.error.message : tr('请稍后再试')}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
          {tr('重试')}
        </Button>
      </div>
    );
  }
  return <ProposalBody pid={pid} p={q.data} writable={writable} isReviewer={isReviewer} />;
}

function counts(p: ChangeProposal) {
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  for (const h of p.hunks) {
    if (h.decision === 'accepted') accepted += 1;
    else if (h.decision === 'rejected') rejected += 1;
    else pending += 1;
  }
  return { accepted, rejected, pending };
}

function ProposalBody({
  pid,
  p,
  writable,
  isReviewer,
}: {
  pid: string;
  p: ChangeProposal;
  writable: boolean;
  isReviewer: boolean;
}) {
  const { variants } = useMotionPreset();
  const decide = useProposalDecisions(pid, p.id);
  const merge = useMergeProposal(pid, p.id);
  const close = useCloseProposal(pid, p.id);
  const [confirm, setConfirm] = useState<null | 'accepted' | 'all'>(null);
  const [conflictAsk, setConflictAsk] = useState<null | 'accepted' | 'all'>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const open = p.status === 'open';
  const editable = open && writable;
  const c = counts(p);
  const conflicts = useMemo(() => new Set(p.conflicts), [p.conflicts]);
  const href = proposalTargetHref(pid, p);
  const noun =
    p.targetKind === 'notebook' ? 'notebook' : (DOC_KIND_NOUN[p.docKind ?? 'doc'] ?? tr('文档'));

  const setDecision = (h: ProposalHunk, d: HunkDecision) => {
    decide.mutate(
      { [h.id]: h.decision === d ? 'pending' : d },
      {
        onError: (err) =>
          toast({
            title: err instanceof ApiRequestError ? err.message : tr('没有保存成功，请稍后再试'),
            tone: 'danger',
          }),
      },
    );
  };

  const doMerge = (which: 'accepted' | 'all', skipConflicts: boolean) => {
    merge.mutate(
      {
        acceptPending: which === 'all',
        skipConflicts,
        lgtm: which === 'all' && isReviewer,
      },
      {
        onSuccess: (r) => {
          setConfirm(null);
          setConflictAsk(null);
          const n = r.mergeResult?.applied.length ?? 0;
          toast({
            title: tr('已合入 {n} 处改动', { n }),
            description: tr('合入前后的内容都存成了版本，可以在版本历史里对比或回滚'),
            tone: 'success',
          });
        },
        onError: (err) => {
          setConfirm(null);
          if (
            err instanceof ApiRequestError &&
            err.status === 409 &&
            !skipConflicts &&
            p.conflicts.length
          ) {
            setConflictAsk(which);
            return;
          }
          toast({
            title: err instanceof ApiRequestError ? err.message : tr('没有合入成功，请稍后再试'),
            tone: 'danger',
          });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      {/* 概要 */}
      <div className="rounded-lg border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-small text-fg-muted">
          {href ? (
            <Link
              to={href}
              className="inline-flex min-w-0 items-center gap-1 rounded-sm text-fg hover:text-accent-text"
            >
              <span className="truncate">
                {tr('{noun}「{targetTitle}」', { noun, targetTitle: p.targetTitle })}
              </span>
              <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
            </Link>
          ) : (
            <span className="truncate text-fg">
              {tr('{noun}「{targetTitle}」', { noun, targetTitle: p.targetTitle })}
            </span>
          )}
          <span className="tabular-nums">
            {tr('共 ')}
            {p.hunks.length}
            {tr(' 处改动')}
            {open && (
              <>
                {tr('：已接受 {accepted}，已拒绝 {rejected}，待定 {pending}', {
                  accepted: c.accepted,
                  rejected: c.rejected,
                  pending: c.pending,
                })}
              </>
            )}
          </span>
          {open && p.conflicts.length > 0 && (
            <span className="inline-flex items-center gap-1 text-warning">
              <AlertTriangle size={14} strokeWidth={1.75} aria-hidden />
              {p.conflicts.length}
              {tr(' 处与正文冲突')}
            </span>
          )}
        </div>
        {p.explanation.trim() && (
          <div className="mt-2.5 border-t border-line pt-2.5">
            <Markdown size="compact">{p.explanation}</Markdown>
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {p.status !== 'open' && (
          <motion.div
            key="done"
            variants={variants.fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="status"
            className={cn(
              'flex items-start gap-3 rounded-lg border px-4 py-3 text-small',
              p.status === 'merged'
                ? 'border-success/30 bg-success-soft text-success'
                : 'border-line bg-subtle text-fg-muted',
            )}
          >
            {p.status === 'merged' ? (
              <CircleCheck size={18} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
            ) : (
              <XCircle size={18} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-h3">
                {p.status === 'merged' ? tr('已合入正文') : tr('提案已关闭，没有合入')}
              </p>
              {p.status === 'merged' && p.mergeResult && (
                <p className="text-fg-muted">
                  {p.mergedBy ? trServer(p.mergedBy.name) : null}
                  {tr(' 合入了 ')}
                  {p.mergeResult.applied.length}
                  {tr(' 处，未采纳')} {p.mergeResult.rejected.length}
                  {tr(' 处')}
                  {p.mergeResult.conflicted.length > 0 &&
                    tr('，因冲突跳过 {count} 处', { count: p.mergeResult.conflicted.length })}
                  {p.mergedAt && (
                    <>
                      {' '}
                      · <RelativeTime iso={p.mergedAt} />
                    </>
                  )}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 改动列表 */}
      {p.hunks.length === 0 ? (
        <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
          {tr('草稿和正文一致，这份提案没有改动。')}
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {p.hunks.map((h, i) => (
            <HunkCard
              key={h.id}
              index={i}
              total={p.hunks.length}
              hunk={h}
              unit={p.unit}
              conflict={open && conflicts.has(h.id)}
              result={resultOf(p, h.id)}
              editable={editable}
              onDecide={(d) => setDecision(h, d)}
            />
          ))}
        </ol>
      )}

      {/* 合入 */}
      {editable && p.hunks.length > 0 && (
        <div className="sticky bottom-(--sticky-actions-h) z-sticky -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur-sm">
          <Button
            variant="primary"
            leftIcon={<GitMerge size={16} strokeWidth={1.75} aria-hidden />}
            onClick={() => setConfirm('all')}
            loading={merge.isPending && merge.variables?.acceptPending === true}
          >
            {isReviewer ? tr('LGTM 并合入') : tr('全部接受并合入')}
          </Button>
          <Button
            variant="secondary"
            disabled={c.accepted === 0}
            onClick={() => setConfirm('accepted')}
            loading={merge.isPending && merge.variables?.acceptPending === false}
          >
            {tr('合入已接受的')}
            {c.accepted > 0 ? tr('（{accepted}）', { accepted: c.accepted }) : ''}
          </Button>
          <Button variant="ghost" className="ml-auto" onClick={() => setConfirmClose(true)}>
            {tr('关闭提案')}
          </Button>
        </div>
      )}

      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        size="sm"
        title={
          confirm === 'all'
            ? tr('把还没决定的改动一并接受并合入？')
            : tr('合入已接受的 {accepted} 处改动？', { accepted: c.accepted })
        }
        description={
          confirm === 'all'
            ? tr(
                '已拒绝的 {rejected} 处不会合入，其余 {value} 处写进正文{value2}。合入前的内容会先存成版本。',
                {
                  rejected: c.rejected,
                  value: c.accepted + c.pending,
                  value2: isReviewer ? tr('，同时给这条审阅 LGTM') : '',
                },
              )
            : c.pending > 0
              ? tr('还有 {pending} 处没有决定，合入后视为未采纳。合入前的内容会先存成版本。', {
                  pending: c.pending,
                })
              : tr('合入前的内容会先存成版本，之后可以在版本历史里回滚。')
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {tr('取消')}
            </Button>
            <Button
              variant="primary"
              loading={merge.isPending}
              onClick={() => confirm && doMerge(confirm, false)}
            >
              {tr('合入')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>

      <Dialog
        open={conflictAsk !== null}
        onOpenChange={(o) => !o && setConflictAsk(null)}
        size="sm"
        title={tr('有改动和正文冲突')}
        description={tr(
          '提出这份提案之后，正文里有 {count} 处被人改过，对应的改动没法自动合入。可以跳过这几处、先合入其余部分；被跳过的改动不会丢，仍能在这里看到。',
          { count: p.conflicts.length },
        )}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConflictAsk(null)}>
              {tr('取消')}
            </Button>
            <Button
              variant="primary"
              loading={merge.isPending}
              onClick={() => conflictAsk && doMerge(conflictAsk, true)}
            >
              {tr('跳过冲突并合入')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>

      <Dialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        size="sm"
        title={tr('关闭这份提案？')}
        description={tr('正文保持不变，这份提案和它的审阅一并关闭，记录会保留。')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="danger"
              loading={close.isPending}
              onClick={() =>
                close.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmClose(false);
                    toast({ title: tr('提案已关闭'), tone: 'success' });
                  },
                  onError: (err) =>
                    toast({
                      title: err instanceof ApiRequestError ? err.message : tr('请稍后再试'),
                      tone: 'danger',
                    }),
                })
              }
            >
              {tr('关闭提案')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}

type HunkResult = 'applied' | 'rejected' | 'conflicted' | null;

function resultOf(p: ChangeProposal, id: string): HunkResult {
  const r = p.mergeResult;
  if (!r) return null;
  if (r.applied.includes(id)) return 'applied';
  if (r.conflicted.includes(id)) return 'conflicted';
  return 'rejected';
}

const RESULT_BADGE: Record<
  Exclude<HunkResult, null>,
  { label: string; tone: 'success' | 'neutral' | 'warning' }
> = {
  applied: { label: tr('已合入'), tone: 'success' },
  rejected: { label: tr('未采纳'), tone: 'neutral' },
  conflicted: { label: tr('冲突跳过'), tone: 'warning' },
};

function HunkCard({
  index,
  total,
  hunk,
  unit,
  conflict,
  result,
  editable,
  onDecide,
}: {
  index: number;
  total: number;
  hunk: ProposalHunk;
  unit: 'block' | 'line' | null;
  conflict: boolean;
  result: HunkResult;
  editable: boolean;
  onDecide: (d: HunkDecision) => void;
}) {
  const d = hunk.decision;
  return (
    <li
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border bg-surface transition-colors duration-(--dur-fast)',
        d === 'accepted' && !result
          ? 'border-success/40'
          : d === 'rejected' && !result
            ? 'border-line opacity-75'
            : 'border-line',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-subtle px-3 py-2">
        <span className="text-caption text-fg-muted tabular-nums">
          {tr('改动 {value}/{total}', { value: index + 1, total })}
        </span>
        <span className="text-caption text-fg-subtle">{hunkLabel(hunk)}</span>
        {conflict && (
          <Tooltip content={tr('提出之后，正文这一处被人改过，合入时会跳过')}>
            <span tabIndex={0} className="rounded-sm">
              <Badge tone="warning" dot>
                {tr('冲突')}
              </Badge>
            </span>
          </Tooltip>
        )}
        {result && <Badge tone={RESULT_BADGE[result].tone}>{RESULT_BADGE[result].label}</Badge>}
        <span className="ml-auto flex items-center gap-1.5">
          {editable ? (
            <>
              <DecisionButton
                active={d === 'accepted'}
                tone="accept"
                onClick={() => onDecide('accepted')}
              />
              <DecisionButton
                active={d === 'rejected'}
                tone="reject"
                onClick={() => onDecide('rejected')}
              />
            </>
          ) : (
            !result &&
            d !== 'pending' && (
              <Badge tone={d === 'accepted' ? 'success' : 'neutral'}>
                {d === 'accepted' ? tr('已接受') : tr('已拒绝')}
              </Badge>
            )
          )}
        </span>
      </div>
      <div className="p-3">
        <HunkBody hunk={hunk} unit={unit} />
      </div>
    </li>
  );
}

function DecisionButton({
  active,
  tone,
  onClick,
}: {
  active: boolean;
  tone: 'accept' | 'reject';
  onClick: () => void;
}) {
  const accept = tone === 'accept';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-small transition-colors duration-(--dur-fast) pointer-coarse:after:absolute pointer-coarse:after:-inset-2',
        active
          ? accept
            ? 'border-success/40 bg-success-soft text-success'
            : 'border-danger/40 bg-danger-soft text-danger'
          : 'border-line-strong bg-surface text-fg-muted hover:bg-subtle hover:text-fg',
      )}
    >
      {active ? (
        accept ? (
          <Check size={14} strokeWidth={1.75} aria-hidden />
        ) : (
          <X size={14} strokeWidth={1.75} aria-hidden />
        )
      ) : accept ? (
        <Check size={14} strokeWidth={1.75} aria-hidden />
      ) : (
        <Undo2 size={14} strokeWidth={1.75} aria-hidden />
      )}
      {accept ? (active ? tr('已接受') : tr('接受')) : active ? tr('已拒绝') : tr('拒绝')}
    </button>
  );
}

function hunkLabel(h: ProposalHunk): string {
  if (h.kind === 'cell') return tr('单元格 {sheet}!{ref}', { sheet: h.sheet, ref: h.ref });
  if (h.kind === 'nb_cell')
    return h.op === 'add'
      ? tr('新增单元格')
      : h.op === 'remove'
        ? tr('删除单元格')
        : tr('修改单元格');
  if (!h.old.length) return tr('新增内容');
  if (!h.new.length) return tr('删除内容');
  return tr('修改内容');
}

function HunkBody({ hunk, unit }: { hunk: ProposalHunk; unit: 'block' | 'line' | null }) {
  if (hunk.kind === 'cell') {
    return (
      <div className="text-small">
        <CellChange old={hunk.old} next={hunk.new} />
      </div>
    );
  }
  if (hunk.kind === 'nb_cell') {
    return (
      <NotebookCellDiff status={hunk.op} cellType={hunk.cellType} old={hunk.old} next={hunk.new} />
    );
  }
  const mono = unit === 'line';
  const row = (kind: 'same' | 'add' | 'del', text: string, k: string) => (
    <li
      key={k}
      className={cn(
        'flex min-w-0',
        unit === 'block' && 'py-1',
        kind === 'add' && 'bg-success-soft text-fg',
        kind === 'del' && 'bg-danger-soft text-fg-muted line-through decoration-danger/60',
        kind === 'same' && 'text-fg-subtle',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'w-6 shrink-0 text-center select-none',
          kind === 'add' && 'text-success',
          kind === 'del' && 'text-danger',
        )}
      >
        {kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}
      </span>
      <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
        {kind !== 'same' && (
          <span className="sr-only">{kind === 'add' ? tr('新增：') : tr('删除：')}</span>
        )}
        {text || ' '}
      </span>
    </li>
  );
  return (
    <ol
      className={cn(
        'overflow-hidden rounded-md border border-line text-small leading-relaxed',
        mono && 'font-mono',
        unit === 'block' && 'divide-y divide-line',
      )}
    >
      {hunk.before.map((t, i) => row('same', clip(t), `b${i}`))}
      {hunk.old.map((t, i) => row('del', t, `o${i}`))}
      {hunk.new.map((t, i) => row('add', t, `n${i}`))}
      {hunk.after.map((t, i) => row('same', clip(t), `a${i}`))}
    </ol>
  );
}

/** 上下文只露一小段 */
function clip(s: string): string {
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
