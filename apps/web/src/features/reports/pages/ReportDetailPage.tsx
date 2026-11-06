import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import type { Report } from '@srh/shared';
import {
  BadgeCheck,
  CalendarRange,
  Download,
  Ellipsis,
  FileOutput,
  FileSymlink,
  ListTodo,
  RefreshCw,
  SearchX,
  Send,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import {
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  RelativeTime,
  Skeleton,
  toast,
} from '@/components/ui';
import { BackLink } from '@/components/layout/BackLink';
import { Page, PageTitle, PageActions } from '@/components/layout/Page';
import { ApiRequestError } from '@/lib/api';
import { useMotionPreset } from '@/lib/motion';
import { useMediaQuery } from '@/lib/use-media-query';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { RequestReviewDialog } from '@/features/reviews';
import {
  useDeleteReport,
  useRegenerateReport,
  useReport,
  useReportsRealtime,
  useSaveReportAsDocument,
  useUpdateReport,
} from '../api';
import { PlanTodosDialog } from '../components/PlanTodosDialog';
import { ActorAvatar, ReportStatusBadge } from '../components/ReportBits';
import { ReportEditor, ReportReader } from '../components/ReportEditor';
import {
  GenerateErrorCard,
  GeneratingPanel,
  InlineTitle,
  RegeneratePopover,
  ReportSources,
} from '../components/ReportPanels';
import { downloadText, reportFileName, reportMarkdown } from '../lib/export';
import { formatPeriod } from '../lib/period';
import { tr, trServer } from '@/lib/i18n';

/** 组会汇报详情：生成中 → 草稿编辑（自动保存）→ 定稿只读；导出、存为文档、拆成待办 */
export function ReportDetailPage() {
  const pid = useProjectId();
  const { reportId = '' } = useParams();
  const query = useReport(pid, reportId);
  useReportsRealtime(pid);
  const backTo = `/p/${pid}/reports`;

  if (query.isPending) {
    return (
      <Page width="full" className="max-w-6xl">
        <BackLink to={backTo}>{tr('全部汇报')}</BackLink>
        <div aria-busy="true" aria-label={tr('正在加载汇报')} className="mt-3">
          <Skeleton className="mb-3 h-8 w-2/3 max-w-md" />
          <Skeleton className="mb-8 h-4 w-1/2 max-w-sm" />
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className={i % 2 ? 'h-3.5 w-4/5' : 'h-3.5 w-full'} />
            ))}
          </div>
        </div>
      </Page>
    );
  }

  if (query.isError || !query.data) {
    const notFound = query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <Page width="feed">
        <BackLink to={backTo}>{tr('全部汇报')}</BackLink>
        <EmptyState
          className="mt-6"
          icon={SearchX}
          title={notFound ? tr('这份汇报不存在或已被删除') : tr('汇报没能加载出来')}
          description={
            notFound
              ? tr('可能已经被别人删除了，回到列表看看其他汇报。')
              : `${query.error?.message ?? tr('请稍后再试。')}`
          }
          action={
            notFound ? undefined : (
              <Button variant="secondary" onClick={() => void query.refetch()}>
                {tr('重试')}
              </Button>
            )
          }
        />
      </Page>
    );
  }

  return <ReportView pid={pid} report={query.data} />;
}

/** 汇报生成后，论文 / 实验记录又改过：明显标出可能过期，并给出一键重新生成 */
function OutdatedBanner({
  pid,
  sources,
  canRegenerate,
  regenerating,
  onRegenerate,
}: {
  pid: string;
  sources: NonNullable<Report['outdatedBy']>;
  canRegenerate: boolean;
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  const shown = sources.slice(0, 3);
  return (
    <div
      role="status"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-4 py-3 text-small text-fg sm:flex-row sm:items-center"
    >
      <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-pretty">
        <span className="font-medium">{tr('内容可能已过期：')}</span>
        {tr('汇报生成后，')}
        {shown.map((s, i) => (
          <span key={s.id}>
            {i > 0 && tr('、')}
            <Link
              className="text-accent-text hover:underline"
              to={
                s.kind === 'document'
                  ? `/p/${pid}/docs/${s.id}`
                  : s.kind === 'research'
                    ? `/p/${pid}/research/${s.id}`
                    : `/p/${pid}/experiments/${s.id}`
              }
            >
              {tr('「{title}」', { title: s.title })}
            </Link>
          </span>
        ))}
        {sources.length > shown.length && tr(' 等 {count} 项', { count: sources.length })}
        {tr('又有更新，里面的数字和结论可能和汇报对不上。')}
      </p>
      {canRegenerate && (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0 self-start sm:self-auto"
          leftIcon={<RefreshCw strokeWidth={1.75} aria-hidden />}
          loading={regenerating}
          onClick={onRegenerate}
        >
          {tr('按最新内容重新生成')}
        </Button>
      )}
    </div>
  );
}

function ReportView({ pid, report }: { pid: string; report: Report }) {
  const navigate = useNavigate();
  const canEdit = canWrite(useMyRole(pid));
  const { variants } = useMotionPreset();
  const mobile = useMediaQuery('(max-width: 1279.98px)');
  const update = useUpdateReport(pid, report.id);
  const regenerate = useRegenerateReport(pid, report.id);
  const remove = useDeleteReport(pid, report.id);
  const saveDoc = useSaveReportAsDocument(pid, report.id);
  const [todos, setTodos] = useState({ open: false, key: 0 });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const generating = report.status === 'generating';
  const final = report.status === 'final';
  const editable = canEdit && report.status === 'draft';

  const runRegenerate = (instructions: string) =>
    regenerate.mutate(instructions, {
      onError: (err) => toast.error(tr('没能重新生成'), err.message),
    });

  const setStatus = (status: 'draft' | 'final') =>
    update.mutate(
      { status },
      {
        onSuccess: () => toast.success(status === 'final' ? tr('已定稿') : tr('已改回草稿')),
        onError: (err) => toast.error(tr('操作失败'), err.message),
      },
    );

  const saveTitle = (title: string) =>
    update.mutate({ title }, { onError: (err) => toast.error(tr('标题没能保存'), err.message) });

  const exportMd = () => {
    downloadText(reportFileName(report), reportMarkdown(report));
  };

  const docHref = (id: string) => `/p/${pid}/docs/${id}`;
  const openDocument = () => navigate(docHref(report.documentId ?? ''));
  const openTodos = () => setTodos((t) => ({ open: true, key: t.key + 1 }));
  const saveAsDocument = () =>
    saveDoc.mutate(undefined, {
      onSuccess: ({ document }) =>
        toast({
          title: tr('已存为协同文档'),
          description: tr('「{title}」，大家可以一起继续改。', { title: document.title }),
          tone: 'success',
          action: { label: tr('打开'), onClick: () => navigate(docHref(document.id)) },
        }),
      onError: (err) => toast.error(tr('没能存为协同文档'), err.message),
    });

  const doDelete = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(tr('汇报已删除'));
        navigate(`/p/${pid}/reports`, { replace: true });
      },
      onError: (err) => toast.error(tr('删除失败'), err.message),
    });

  return (
    <Page width="full" className="max-w-6xl">
      <div className="mb-2">
        <BackLink to={`/p/${pid}/reports`}>{tr('全部汇报')}</BackLink>
      </div>

      <header className="mb-6">
        <PageTitle>
          <InlineTitle title={report.title} canEdit={canEdit && !generating} onSave={saveTitle} />
        </PageTitle>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small text-fg-muted">
          <ReportStatusBadge status={report.status} />
          <span className="flex items-center gap-1.5">
            <CalendarRange size={14} strokeWidth={1.75} aria-hidden />
            {formatPeriod(report.periodStart, report.periodEnd)}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <ActorAvatar actor={report.createdBy} />
            <span className="truncate">{trServer(report.createdBy.name)}</span>
          </span>
          <span className="text-caption text-fg-subtle">
            {tr('更新于 ')}
            <RelativeTime iso={report.updatedAt} />
          </span>
        </div>
      </header>

      {/* 手机上只留主操作（定稿 / 改回草稿、重新生成），其余收进「⋯」菜单，一行放得下，不用横滑 */}
      <PageActions>
        {canEdit && !final && (
          <Button
            variant="primary"
            leftIcon={<BadgeCheck strokeWidth={1.75} aria-hidden />}
            disabled={generating}
            loading={update.isPending && update.variables?.status === 'final'}
            onClick={() => setStatus('final')}
          >
            {tr('定稿')}
          </Button>
        )}
        {canEdit && final && (
          <Button
            variant="secondary"
            leftIcon={<Undo2 strokeWidth={1.75} aria-hidden />}
            loading={update.isPending && update.variables?.status === 'draft'}
            onClick={() => setStatus('draft')}
          >
            {tr('改回草稿')}
          </Button>
        )}
        {canEdit && !final && (
          <RegeneratePopover
            compact={mobile}
            onConfirm={runRegenerate}
            loading={regenerate.isPending}
            disabled={generating}
          />
        )}
        {!mobile && canEdit && (
          <Button
            variant="secondary"
            leftIcon={<ListTodo strokeWidth={1.75} aria-hidden />}
            disabled={generating}
            onClick={openTodos}
          >
            {tr('拆成待办')}
          </Button>
        )}
        {!mobile &&
          (report.documentId ? (
            <Button
              variant="secondary"
              leftIcon={<FileSymlink strokeWidth={1.75} aria-hidden />}
              onClick={openDocument}
            >
              {tr('打开协同文档')}
            </Button>
          ) : (
            canEdit && (
              <Button
                variant="secondary"
                leftIcon={<FileOutput strokeWidth={1.75} aria-hidden />}
                disabled={generating}
                loading={saveDoc.isPending}
                onClick={saveAsDocument}
              >
                {tr('存为协同文档')}
              </Button>
            )
          ))}
        {!mobile && canEdit && (
          <Button
            variant="secondary"
            leftIcon={<Send strokeWidth={1.75} aria-hidden />}
            disabled={generating}
            onClick={() => setReviewOpen(true)}
          >
            {tr('请求审阅')}
          </Button>
        )}
        <Menu
          align="end"
          label={tr('更多操作')}
          trigger={
            <IconButton label={tr('更多操作')} variant={mobile ? 'secondary' : 'ghost'}>
              <Ellipsis strokeWidth={1.75} aria-hidden />
            </IconButton>
          }
        >
          {mobile && (
            <>
              {canEdit && (
                <MenuItem
                  icon={<Send strokeWidth={1.75} aria-hidden />}
                  disabled={generating}
                  onSelect={() => setReviewOpen(true)}
                >
                  {tr('请求审阅')}
                </MenuItem>
              )}
              {report.documentId ? (
                <MenuItem
                  icon={<FileSymlink strokeWidth={1.75} aria-hidden />}
                  onSelect={openDocument}
                >
                  {tr('打开协同文档')}
                </MenuItem>
              ) : (
                canEdit && (
                  <MenuItem
                    icon={<FileOutput strokeWidth={1.75} aria-hidden />}
                    disabled={generating || saveDoc.isPending}
                    onSelect={saveAsDocument}
                  >
                    {tr('存为协同文档')}
                  </MenuItem>
                )
              )}
              {canEdit && (
                <MenuItem
                  icon={<ListTodo strokeWidth={1.75} aria-hidden />}
                  disabled={generating}
                  onSelect={openTodos}
                >
                  {tr('拆成待办')}
                </MenuItem>
              )}
              <MenuSeparator />
            </>
          )}
          <MenuItem
            icon={<Download strokeWidth={1.75} aria-hidden />}
            disabled={generating}
            onSelect={exportMd}
          >
            {tr('导出 Markdown')}
          </MenuItem>
          {canEdit && report.documentId && (
            <MenuItem
              icon={<FileOutput strokeWidth={1.75} aria-hidden />}
              disabled={generating}
              onSelect={saveAsDocument}
              description={tr('再生成一份新的协同文档')}
            >
              {tr('重新存为协同文档')}
            </MenuItem>
          )}
          {canEdit && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                danger
                onSelect={() => setConfirmDelete(true)}
              >
                {tr('删除汇报')}
              </MenuItem>
            </>
          )}
        </Menu>
      </PageActions>

      {report.error && !generating && (
        <GenerateErrorCard
          error={report.error}
          canRetry={canEdit}
          retrying={regenerate.isPending}
          onRetry={() => runRegenerate('')}
        />
      )}

      {!generating && !report.error && report.outdatedBy && report.outdatedBy.length > 0 && (
        <OutdatedBanner
          pid={pid}
          sources={report.outdatedBy}
          canRegenerate={canEdit && !final}
          regenerating={regenerate.isPending}
          onRegenerate={() => runRegenerate('')}
        />
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={generating ? 'generating' : 'content'}
          variants={variants.fadeIn}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          {generating ? (
            <GeneratingPanel report={report} />
          ) : editable ? (
            <ReportEditor pid={pid} report={report} />
          ) : (
            <ReportReader pid={pid} content={report.content} />
          )}
        </motion.div>
      </AnimatePresence>

      <ReportSources report={report} />

      {canEdit && (
        <PlanTodosDialog
          key={todos.key}
          pid={pid}
          reportId={report.id}
          content={report.content}
          open={todos.open}
          onOpenChange={(open) => setTodos((t) => ({ ...t, open }))}
        />
      )}
      {canEdit && (
        <RequestReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          defaultTarget={{ kind: 'report', id: report.id, title: report.title || tr('组会汇报') }}
        />
      )}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tr('删除这份汇报？')}
        description={tr('删除后无法恢复。已经存为协同文档的副本和拆出来的待办不受影响。')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {tr('取消')}
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={doDelete}>
              {tr('删除')}
            </Button>
          </>
        }
      />
    </Page>
  );
}
