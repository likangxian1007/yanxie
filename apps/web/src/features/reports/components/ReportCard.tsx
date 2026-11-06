import { Link } from 'react-router';
import { ResourcePreviewLink } from '@/features/resource-preview/ResourcePreviewLink';
import type { Report } from '@srh/shared';
import { CalendarRange, CircleAlert } from 'lucide-react';
import { AgentThinking, RelativeTime } from '@/components/ui';
import { statsSummary } from '../lib/export';
import { formatPeriod } from '../lib/period';
import { ActorAvatar, ReportStatusBadge } from './ReportBits';
import { tr, trServer } from '@/lib/i18n';

/** 汇报行：标题、期间、状态、上下文规模、作者、更新时间。 */
export function ReportCard({ report, href }: { report: Report; href: string }) {
  const generating = report.status === 'generating';
  const summary = statsSummary(report.stats);
  return (
    <article className="relative flex min-w-0 flex-col gap-2 px-4 py-3 transition-colors hover:bg-subtle sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-body font-medium text-fg">
            <ResourcePreviewLink
              type="report"
              id={report.id}
              className="outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
            >
              {report.title || tr('组会汇报')}
            </ResourcePreviewLink>
          </h3>
          <ReportStatusBadge status={report.status} />
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-small text-fg-muted">
          <CalendarRange size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          {formatPeriod(report.periodStart, report.periodEnd)}
          {summary && !generating && !report.error && (
            <span className="hidden truncate text-fg-subtle lg:inline">
              <span aria-hidden> · </span>
              <span>{summary}</span>
            </span>
          )}
        </p>
        {generating ? (
          <AgentThinking label={tr('正在整理这一期的上下文')} className="mt-1" />
        ) : report.error ? (
          <p className="mt-1 flex items-center gap-1.5 text-small text-warning">
            <CircleAlert size={14} aria-hidden />
            <span className="break-words">{tr('生成失败：{error}', { error: report.error })}</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-caption font-normal text-fg-subtle">
        <span className="inline-flex w-24 items-center gap-1.5">
          <ActorAvatar actor={report.createdBy} />
          <span className="truncate">{trServer(report.createdBy.name)}</span>
        </span>
        <RelativeTime iso={report.updatedAt} className="w-16 text-right" />
      </div>
      <Link
        to={href}
        className="relative z-10 shrink-0 rounded-md px-2 py-2 text-small text-fg-muted hover:bg-muted hover:text-fg max-md:min-h-11"
      >
        {tr('完整页面')}
      </Link>
    </article>
  );
}
