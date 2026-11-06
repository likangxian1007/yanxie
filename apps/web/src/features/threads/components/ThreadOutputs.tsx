import { Link } from 'react-router';
import {
  ArrowUpRight,
  FileText,
  FlaskConical,
  FolderOpen,
  Link2,
  Paperclip,
  PencilLine,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import type { OutputKind } from '@srh/shared';
import { Badge, EmptyState, RelativeTime, Skeleton } from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { summarizeCall, toolCallOf, type SummaryContext } from '../step-summary';
import { OUTPUT_KIND_LABEL, outputHref, type ChangeEntry, type OutputEntry } from '../thread-utils';
import { useDocTitleContext } from '../use-doc-titles';
import { RawData } from './StepDisclosure';
import { FileHistoryButton } from '@/features/versioning/components/FileHistoryButton';
import { tr, trServer } from '@/lib/i18n';

const OUTPUT_ICON: Record<OutputKind, LucideIcon> = {
  file: Paperclip,
  link: Link2,
  document: FileText,
  experiment: FlaskConical,
  report: Presentation,
  research: FlaskConical,
};

export interface ThreadOutputsProps {
  projectId: string;
  outputs: OutputEntry[];
  changes: ChangeEntry[];
  loadingMessages: boolean;
  loadingSteps: boolean;
}

function OutputCard({ projectId, entry }: { projectId: string; entry: OutputEntry }) {
  const { output, message } = entry;
  const Icon = OUTPUT_ICON[output.kind];
  const resolved = outputHref(projectId, output);
  const external = resolved.external;
  // 指向某条消息的产出：切到对话并定位到那条消息
  const href = resolved.href.startsWith('#') ? `?tab=chat${resolved.href}` : resolved.href;
  const cls = cn(
    'group flex min-w-0 items-start gap-3 rounded-lg border border-line bg-surface p-3 shadow-xs',
    'transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard) hover:border-line-strong hover:shadow-sm',
  );
  const inner = (
    <>
      <span
        aria-hidden
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-md ring-1',
          message.author.kind === 'agent'
            ? 'bg-agent-soft text-agent ring-agent/15'
            : 'bg-subtle text-fg-muted ring-line',
        )}
      >
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-fg">{output.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-caption font-normal text-fg-subtle">
          <span>{OUTPUT_KIND_LABEL[output.kind]}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{trServer(message.author.name)}</span>
          <span aria-hidden>·</span>
          <RelativeTime iso={message.createdAt} />
        </span>
      </span>
      <ArrowUpRight
        size={16}
        strokeWidth={1.75}
        aria-hidden
        className="mt-0.5 shrink-0 text-fg-subtle transition-transform duration-(--dur-fast) group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
      />
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cls}>
      {inner}
    </a>
  ) : (
    <Link to={href} className={cls}>
      {inner}
    </Link>
  );
}

/** 一条改动：哪份文档 / 文件、改了哪一节、改动规模，结果用中文说；原始数据收起。 */
function ChangeRow({ entry, ctx }: { entry: ChangeEntry; ctx: SummaryContext }) {
  const call = toolCallOf(entry.step, entry.result);
  const s = summarizeCall(call, ctx);
  const failed = s.tone === 'error';
  return (
    <li className="flex min-w-0 items-start gap-3 px-3 py-2.5">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ring-1',
          failed
            ? 'bg-danger-soft text-danger ring-danger/30'
            : 'bg-agent-soft text-agent ring-agent/15',
        )}
      >
        <PencilLine size={13} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-small text-pretty break-words text-fg">{s.text}</p>
        {(s.diff || s.outcome) && (
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption font-normal">
            {s.diff && <span className="text-fg-muted tabular-nums">{s.diff}</span>}
            {s.outcome && (
              <span className={cn('min-w-0 break-words', failed ? 'text-danger' : 'text-fg-muted')}>
                {s.outcome}
              </span>
            )}
          </p>
        )}
        <RawData call={call} className="mt-1" />
      </div>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {failed && <Badge tone="danger">{tr('没成功')}</Badge>}
        {s.tone === 'success' && <Badge tone="success">{tr('已完成')}</Badge>}
        <RelativeTime
          iso={entry.step.createdAt}
          className="text-caption font-normal text-fg-subtle"
        />
      </span>
    </li>
  );
}

function SectionTitle({ children, count }: { children: string; count: number }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-caption text-fg-muted">
      {children}
      <span className="font-normal text-fg-subtle tabular-nums">{count}</span>
    </h2>
  );
}

/** 产出与改动：线程消息里挂的产出（文件、文档、实验……）+ agent 做过的写入类工具调用。 */
export function ThreadOutputs({
  projectId,
  outputs,
  changes,
  loadingMessages,
  loadingSteps,
}: ThreadOutputsProps) {
  const ctx = useDocTitleContext(projectId);
  const empty = !loadingMessages && !loadingSteps && outputs.length === 0 && changes.length === 0;

  return (
    <div className="flex flex-col gap-8">
      {empty ? (
        <EmptyState
          tone="agent"
          icon={FolderOpen}
          title={tr('还没有产出')}
          description={tr('agent 写的文档、跑的实验、改过的文件都会汇总在这里，方便你逐个查看。')}
        />
      ) : (
        <>
          <section aria-label={tr('成果')}>
            <SectionTitle count={outputs.length}>{tr('成果')}</SectionTitle>
            {loadingMessages ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Skeleton className="h-16 rounded-lg" />
                <Skeleton className="h-16 rounded-lg" />
              </div>
            ) : outputs.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-small text-fg-subtle">
                {tr('这个线程还没有附带产出。')}
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {outputs.map((entry) => (
                  <li
                    key={`${entry.output.kind}:${entry.output.ref}`}
                    className="flex min-w-0 items-center gap-1"
                  >
                    <div className="min-w-0 flex-1">
                      <OutputCard projectId={projectId} entry={entry} />
                    </div>
                    {entry.output.kind === 'file' && (
                      <FileHistoryButton
                        pid={projectId}
                        fileId={entry.output.ref}
                        title={entry.output.title}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label={tr('改动')}>
            <SectionTitle count={changes.length}>{tr('改动')}</SectionTitle>
            {loadingSteps ? (
              <Skeleton className="h-24 rounded-lg" />
            ) : changes.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-small text-fg-subtle">
                {tr('agent 还没有写入或修改任何东西。')}
              </p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
                {changes.map((entry) => (
                  <ChangeRow key={entry.step.id} entry={entry} ctx={ctx} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <nav aria-label={tr('相关页面')} className="flex flex-wrap gap-x-4 gap-y-2 text-small">
        <Link
          to={projectPath(projectId, 'docs')}
          className="inline-flex items-center gap-1.5 text-accent-text hover:underline"
        >
          <FileText size={14} strokeWidth={1.75} aria-hidden />
          {tr('全部文档')}
        </Link>
      </nav>
    </div>
  );
}
