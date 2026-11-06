import { previewReturnTo, resourcePageHref } from '@/features/resource-preview/links';
import { useLocation } from 'react-router';
import { ListToolbar } from '@/components/layout/ListToolbar';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { useState } from 'react';
import { motion } from 'motion/react';
import { Presentation, Sparkles } from 'lucide-react';
import { Button, EmptyState, Input, Select, Skeleton } from '@/components/ui';
import { Page, PageTitle, PageActions } from '@/components/layout/Page';
import { useMotionPreset } from '@/lib/motion';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useReports, useReportsRealtime } from '../api';
import { GenerateReportDialog } from '../components/GenerateReportDialog';
import { ReportCard } from '../components/ReportCard';
import { tr } from '@/lib/i18n';

/** 组会汇报列表 */
export function ReportsPage() {
  const pid = useProjectId();
  const location = useLocation();
  useListStateScope('reports');
  const canEdit = canWrite(useMyRole(pid));
  const { variants, stagger } = useMotionPreset();
  const query = useReports(pid);
  useReportsRealtime(pid);
  const [dialog, setDialog] = useState({ open: false, key: 0 });

  const openDialog = () => setDialog((d) => ({ open: true, key: d.key + 1 }));
  const generateButton = canEdit ? (
    <Button
      variant="primary"
      leftIcon={<Sparkles strokeWidth={1.75} aria-hidden />}
      onClick={openDialog}
    >
      {tr('生成汇报')}
    </Button>
  ) : undefined;

  const reports = query.data ?? [];
  const [search, setSearch] = useListQueryState('q', '');
  const [status, setStatus] = useListQueryState('status', 'all');
  const visible = reports.filter(
    (report) =>
      (!search.trim() || report.title.toLowerCase().includes(search.trim().toLowerCase())) &&
      (status === 'all' || report.status === status),
  );

  return (
    <Page width="feed">
      <PageTitle>{tr('组会汇报')}</PageTitle>
      <PageActions>{reports.length > 0 ? generateButton : undefined}</PageActions>

      <ListToolbar
        className="mb-4"
        search={
          <Input
            type="search"
            aria-label={tr('搜索汇报')}
            placeholder={tr('搜索汇报')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
        filters={
          <>
            <Select
              aria-label={tr('汇报状态')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">{tr('全部状态')}</option>
              <option value="draft">{tr('草稿')}</option>
              <option value="generating">{tr('生成中')}</option>
              <option value="final">{tr('定稿')}</option>
            </Select>
          </>
        }
        activeFilterCount={Number(status !== 'all')}
      />

      {query.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label={tr('正在加载汇报')}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-line bg-surface p-4">
              <Skeleton className="mb-3 h-4 w-1/2" />
              <Skeleton className="mb-2 h-3 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-danger-soft p-4 text-small text-danger">
          <p>{tr('汇报列表没能加载出来：{message}', { message: query.error.message })}</p>
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
            {tr('重试')}
          </Button>
        </div>
      ) : reports.length === 0 ? (
        <EmptyState
          framed
          icon={Presentation}
          tone="agent"
          title={tr('还没有组会汇报')}
          action={generateButton}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Presentation}
          title={tr('没有符合条件的汇报')}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch('');
                setStatus('all');
              }}
            >
              {tr('清除筛选')}
            </Button>
          }
        />
      ) : (
        <motion.ul
          variants={stagger()}
          initial="hidden"
          animate="visible"
          aria-label={tr('汇报列表')}
          className="research-list"
        >
          {visible.map((r) => (
            <motion.li key={r.id} variants={variants.fadeUp} className="research-row">
              <ReportCard
                report={r}
                href={resourcePageHref(
                  pid,
                  { type: 'report', id: r.id },
                  previewReturnTo(location),
                )}
              />
            </motion.li>
          ))}
        </motion.ul>
      )}

      {canEdit && (
        <GenerateReportDialog
          key={dialog.key}
          pid={pid}
          open={dialog.open}
          onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        />
      )}
    </Page>
  );
}
