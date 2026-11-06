import { useState } from 'react';
import { motion } from 'motion/react';
import { Archive, ArrowLeft, FlaskConical, GitCompare, Pencil, Plus, Send } from 'lucide-react';
import { PLAN_STATUS_LABEL, type Plan } from '@srh/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Markdown,
  RelativeTime,
  Textarea,
  toast,
} from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { useArchivePlan, useCreateExploration, useSavePlanContent } from '../api';
import { PlanDiff } from './PlanDiff';
import { ProposalFormDialog } from './ProposalFormDialog';
import { errorText } from './shared';
import { tr, trServer } from '@/lib/i18n';

export interface ExplorationsTabProps {
  pid: string;
  official: Plan | null;
  explorations: Plan[];
  meId: string | undefined;
  canWrite: boolean;
}

/** 探索副本：从正式方案分出来自由修改，对比后可提交为修改正式方案的提案 */
export function ExplorationsTab({
  pid,
  official,
  explorations,
  meId,
  canWrite,
}: ExplorationsTabProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { variants, stagger } = useMotionPreset();

  const open = explorations.find((p) => p.id === openId);
  if (open) {
    return (
      <ExplorationDetail
        pid={pid}
        plan={open}
        official={official}
        editable={canWrite && open.ownerId === meId && open.status === 'active'}
        onBack={() => setOpenId(null)}
      />
    );
  }

  const active = explorations.filter((p) => p.status === 'active');
  const archived = explorations.filter((p) => p.status !== 'active');
  const shown = showArchived ? explorations : active;

  return (
    <div className="flex flex-col gap-3">
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!official}
            leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
            onClick={() => {
              setCreateKey((k) => k + 1);
              setCreating(true);
            }}
          >
            {tr('新建副本')}
          </Button>
          {!official && (
            <span className="text-small text-fg-muted">
              {tr('先建立正式方案，才能从它分出副本。')}
            </span>
          )}
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState
          framed
          icon={FlaskConical}
          tone="agent"
          title={tr('还没有探索副本')}
          description={tr('副本从当前正式方案复制一份，你可以随便改，想清楚了再提交为提案。')}
        />
      ) : (
        <motion.ul
          variants={stagger()}
          initial="hidden"
          animate="visible"
          className="research-list"
          aria-label={tr('探索副本')}
        >
          {shown.map((p) => (
            <motion.li key={p.id} variants={variants.fadeUp} className="research-row">
              <button
                type="button"
                onClick={() => setOpenId(p.id)}
                className="flex min-h-11 w-full cursor-pointer flex-col gap-1 px-3 py-2.5 text-left hover:bg-subtle"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-small font-medium text-fg">
                    {p.title}
                  </span>
                  {p.status !== 'active' && <Badge>{PLAN_STATUS_LABEL[p.status]}</Badge>}
                </span>
                <span className="flex flex-wrap gap-x-2 text-caption text-fg-subtle">
                  <span>{trServer(p.createdBy.name)}</span>
                  <span className="tabular-nums">
                    {tr('基于第 {value} 版', { value: p.forkedFromVersion ?? 0 })}
                  </span>
                  <RelativeTime iso={p.updatedAt} />
                </span>
              </button>
            </motion.li>
          ))}
        </motion.ul>
      )}
      {archived.length > 0 && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowArchived((s) => !s)}>
            {showArchived
              ? tr('隐藏已归档')
              : tr('显示已归档（{count}）', { count: archived.length })}
          </Button>
        </div>
      )}
      <CreateExplorationDialog
        key={createKey}
        pid={pid}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(p) => setOpenId(p.id)}
      />
    </div>
  );
}

function CreateExplorationDialog({
  pid,
  open,
  onOpenChange,
  onCreated,
}: {
  pid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (p: Plan) => void;
}) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const create = useCreateExploration(pid);
  const submit = () => {
    if (!title.trim()) return;
    create.mutate(
      { title: title.trim(), summary },
      {
        onSuccess: (p) => {
          onOpenChange(false);
          onCreated(p);
        },
        onError: (e) => toast({ title: errorText(e, tr('新建副本')), tone: 'danger' }),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr('新建探索副本')}
      description={tr('复制当前正式方案，修改不会影响团队，直到你提交提案并获批。')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!title.trim()}
            onClick={submit}
          >
            {tr('创建副本')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{tr('标题')}</span>
          <Input
            value={title}
            maxLength={200}
            placeholder={tr('例如：换用对比学习的预训练方案')}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{tr('想法概要')}</span>
          <Textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
      </form>
    </Dialog>
  );
}

type DetailMode = 'read' | 'edit' | 'compare';

function ExplorationDetail({
  pid,
  plan,
  official,
  editable,
  onBack,
}: {
  pid: string;
  plan: Plan;
  official: Plan | null;
  editable: boolean;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<DetailMode>('read');
  const [content, setContent] = useState(plan.content);
  const [baseVersion, setBaseVersion] = useState(plan.version);
  const [proposalKey, setProposalKey] = useState(0);
  const [proposing, setProposing] = useState(false);
  const save = useSavePlanContent(pid);
  const archive = useArchivePlan(pid);
  const dirty = content !== plan.content;

  const startEdit = () => {
    setContent(plan.content);
    setBaseVersion(plan.version);
    setMode('edit');
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
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
          <h2 className="min-w-0 text-h3 break-words text-fg">{plan.title}</h2>
          <Badge tone={plan.status === 'active' ? 'accent' : 'neutral'}>
            {PLAN_STATUS_LABEL[plan.status]}
          </Badge>
        </div>
        <p className="mt-1 text-caption text-fg-subtle">
          {trServer(plan.createdBy.name)}
          {tr(' · 基于正式方案第 ')}
          {plan.forkedFromVersion ?? 0}
          {tr(' 版 · 更新于')} <RelativeTime iso={plan.updatedAt} />
        </p>
        {plan.summary && <p className="mt-2 text-small text-fg-muted">{plan.summary}</p>}
      </header>

      <div className="flex flex-wrap gap-2">
        {mode !== 'read' && (
          <Button size="sm" variant="secondary" onClick={() => setMode('read')}>
            {tr('查看正文')}
          </Button>
        )}
        {editable && mode !== 'edit' && (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Pencil strokeWidth={1.75} aria-hidden />}
            onClick={startEdit}
          >
            {tr('编辑副本')}
          </Button>
        )}
        {official && mode !== 'compare' && (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<GitCompare strokeWidth={1.75} aria-hidden />}
            onClick={() => setMode('compare')}
          >
            {tr('对比正式方案')}
          </Button>
        )}
        {editable && official && (
          <Button
            size="sm"
            variant="primary"
            leftIcon={<Send strokeWidth={1.75} aria-hidden />}
            disabled={mode === 'edit' && dirty}
            onClick={() => {
              setProposalKey((k) => k + 1);
              setProposing(true);
            }}
          >
            {tr('提交为提案')}
          </Button>
        )}
        {editable && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Archive strokeWidth={1.75} aria-hidden />}
            loading={archive.isPending}
            onClick={() =>
              archive.mutate(plan.id, {
                onSuccess: () => {
                  toast({ title: tr('副本已归档'), tone: 'success' });
                  onBack();
                },
                onError: (e) => toast({ title: errorText(e, tr('归档副本')), tone: 'danger' }),
              })
            }
          >
            {tr('归档副本')}
          </Button>
        )}
      </div>

      {mode === 'edit' ? (
        <div className="flex flex-col gap-3">
          {plan.version !== baseVersion && (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-small text-warning">
              {tr('副本在别处更新过。保存会被拒绝，请先复制你的修改，再重新进入编辑。')}
            </p>
          )}
          <Textarea
            aria-label={tr('副本正文')}
            rows={14}
            autoGrow
            className="font-mono"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode('read')}>
              {tr('放弃修改')}
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!dirty}
              onClick={() =>
                save.mutate(
                  { planId: plan.id, content, note: '', baseVersion },
                  {
                    onSuccess: (p) => {
                      setBaseVersion(p.version);
                      setMode('read');
                      toast({ title: tr('副本已保存'), tone: 'success' });
                    },
                    onError: (e) => toast({ title: errorText(e, tr('保存副本')), tone: 'danger' }),
                  },
                )
              }
            >
              {tr('保存修改')}
            </Button>
          </div>
        </div>
      ) : mode === 'compare' && official ? (
        <PlanDiff
          before={official.content}
          after={plan.content}
          caption={tr('正式方案第 {version} 版 → 这份副本', { version: official.version })}
          emptyText={tr('副本和当前正式方案一致，还没有改动。')}
        />
      ) : (
        <div className="min-w-0 rounded-lg border border-line bg-surface p-4">
          {plan.content.trim() ? (
            <Markdown size="compact">{plan.content}</Markdown>
          ) : (
            <p className="text-small text-fg-subtle">{tr('副本还没有正文')}</p>
          )}
        </div>
      )}

      {official && (
        <ProposalFormDialog
          key={proposalKey}
          pid={pid}
          open={proposing}
          onOpenChange={setProposing}
          description={tr('把这份副本相对正式方案第 {version} 版的改动提交给负责人审批。', {
            version: official.version,
          })}
          initial={{
            kind: 'plan_change',
            title: plan.title,
            content: plan.content,
            rationale: plan.summary,
            impact: '',
            conditions: '',
            evidence: [],
            sourcePlanId: plan.id,
            basePlanVersion: official.version,
          }}
        />
      )}
    </div>
  );
}
