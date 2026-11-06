import { Link } from 'react-router';
import { ResourcePreviewLink } from '@/features/resource-preview/ResourcePreviewLink';
import { AlertTriangle, FileText, FileWarning, Sigma } from 'lucide-react';
import type { Paper } from '@srh/shared';
import { Avatar, Badge, RelativeTime } from '@/components/ui';
import { SpaceBadge } from '@/features/sharing/SpaceBadge';
import { cn } from '@/lib/cn';
import {
  STATUS_LABEL,
  STATUS_TONE,
  isWorking,
  sharedReady,
  shortAuthors,
  sourceLine,
} from '../lib/format';
import { ParseProgress } from './ParseProgress';
import { tr, trServer } from '@/lib/i18n';

/** 文献行：解析失败保持直接可见，选择框独立于整行链接。 */
export function PaperCard({
  paper,
  href,
  animate,
  selected,
  onToggle,
}: {
  paper: Paper;
  href: string;
  animate: boolean;
  selected: boolean;
  onToggle: (() => void) | null;
}) {
  return (
    <article
      className={cn(
        'group relative flex min-w-0 items-start gap-3 px-4 py-3 transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-subtle',
      )}
    >
      {onToggle ? (
        <label className="relative z-10 -ml-2 flex size-11 shrink-0 cursor-pointer sm:size-8 items-center justify-center">
          <input
            type="checkbox"
            aria-label={tr('选择《{title}》', { title: paper.title })}
            checked={selected}
            onChange={onToggle}
            className="size-4 accent-(--accent)"
          />
        </label>
      ) : (
        <FileText
          size={18}
          strokeWidth={1.75}
          aria-hidden
          className="mt-1 shrink-0 text-fg-subtle"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <h3 className="min-w-0 flex-1 text-body font-medium text-fg">
            <Link
              data-list-item={`paper:${paper.id}`}
              to={href}
              className="outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
            >
              <span className="line-clamp-2 sm:line-clamp-1">{paper.title}</span>
            </Link>
          </h3>
          <SpaceBadge
            space={paper.space}
            ownerUserId={paper.ownerUserId}
            access={paper.access}
            shared={paper.shared}
          />
          {!sharedReady(paper) && (
            <Badge tone={STATUS_TONE[paper.status]} className="shrink-0">
              {STATUS_LABEL[paper.status]}
            </Badge>
          )}
        </div>
        <p className="mt-1 truncate text-small text-fg-muted">
          {shortAuthors(paper.authors)}
          {sourceLine(paper) && <span className="text-fg-subtle"> · {sourceLine(paper)}</span>}
        </p>
        {isWorking(paper.status) ? (
          <div className="mt-2 max-w-md">
            <ParseProgress paper={paper} animate={animate} />
          </div>
        ) : paper.status === 'needs_pdf' || paper.status === 'failed' ? (
          <p className="mt-1 flex items-start gap-1.5 text-caption text-fg-muted">
            {paper.status === 'failed' ? (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
            ) : (
              <FileWarning className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            )}
            <span className="line-clamp-2">{trServer(paper.error ?? '')}</span>
          </p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-subtle">
          <code className="font-mono">{paper.citekey}</code>
          {paper.tags.slice(0, 3).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
          {paper.hasLatexSource && (
            <span className="inline-flex items-center gap-0.5">
              <Sigma size={12} aria-hidden />
              LaTeX
            </span>
          )}
          {paper.pageCount ? (
            <span>{tr('{pageCount} 页', { pageCount: paper.pageCount })}</span>
          ) : null}
          <span className="sm:hidden">
            {trServer(paper.createdBy.name)} · <RelativeTime iso={paper.updatedAt} />
          </span>
        </div>
      </div>
      {paper.projectId && (
        <ResourcePreviewLink
          type="paper"
          id={paper.id}
          aria-label={tr('预览《{title}》', { title: paper.title })}
          className="relative z-10 shrink-0 rounded-md px-2 py-2 text-small text-fg-muted hover:bg-muted hover:text-fg max-md:min-h-11"
        >
          {tr('预览')}
        </ResourcePreviewLink>
      )}
      <div className="hidden shrink-0 items-center gap-3 pt-0.5 text-caption font-normal text-fg-subtle sm:flex">
        <span className="inline-flex w-24 items-center gap-1.5">
          <Avatar
            name={trServer(paper.createdBy.name)}
            kind={paper.createdBy.kind === 'agent' ? 'agent' : 'user'}
            size={20}
          />
          <span className="truncate">{trServer(paper.createdBy.name)}</span>
        </span>
        <RelativeTime iso={paper.updatedAt} className="w-16 text-right" />
      </div>
    </article>
  );
}
