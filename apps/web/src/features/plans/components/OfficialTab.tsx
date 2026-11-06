import { useState } from 'react';
import { ChevronDown, FileCheck2 } from 'lucide-react';
import { diffStats, lineDiff, type Plan, type PlanVersion } from '@srh/shared';
import {
  Button,
  EmptyState,
  Markdown,
  RelativeTime,
  Skeleton,
  Textarea,
  toast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useInitOfficialPlan, usePlanVersions } from '../api';
import { DiffStatsLine, PlanDiff } from './PlanDiff';
import { LoadError, errorText } from './shared';
import { tr, trServer } from '@/lib/i18n';

export interface OfficialTabProps {
  pid: string;
  official: Plan | null;
  canManage: boolean;
}

/** 正式方案：当前版本 + 历史版本（每版相对上一版的改动与审批人） */
export function OfficialTab({ pid, official, canManage }: OfficialTabProps) {
  if (!official) return <InitOfficial pid={pid} canManage={canManage} />;
  return (
    <div className="flex flex-col gap-6">
      <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-h3 text-fg">{official.title}</h2>
          <span className="text-caption text-fg-subtle tabular-nums">
            {tr('第 ')}
            {official.version}
            {tr(' 版 · 更新于 ')}
            <RelativeTime iso={official.updatedAt} />
          </span>
        </div>
        {official.summary && <p className="mb-3 text-small text-fg-muted">{official.summary}</p>}
        {official.content.trim() ? (
          <Markdown size="compact">{official.content}</Markdown>
        ) : (
          <p className="text-small text-fg-subtle">{tr('正式方案还没有正文')}</p>
        )}
      </section>
      <VersionHistory pid={pid} planId={official.id} />
    </div>
  );
}

function InitOfficial({ pid, canManage }: { pid: string; canManage: boolean }) {
  const [content, setContent] = useState('');
  const init = useInitOfficialPlan(pid);
  if (!canManage) {
    return (
      <EmptyState
        framed
        icon={FileCheck2}
        title={tr('还没有正式方案')}
        description={tr('课题负责人建立正式方案后，这里会显示当前版本和历史改动。')}
      />
    );
  }
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-1 text-h3 text-fg">{tr('建立正式方案')}</h2>
      <p className="mb-3 text-small text-fg-muted">
        {tr('写下团队当前认可的方案。之后的修改都要通过提案，由负责人审批后成为新版本。')}
      </p>
      <Textarea
        aria-label={tr('正式方案正文')}
        rows={10}
        autoGrow
        placeholder={tr('支持 Markdown，例如研究问题、方法、数据、评估方式')}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          loading={init.isPending}
          disabled={!content.trim()}
          onClick={() =>
            init.mutate(
              { content },
              {
                onSuccess: () => toast({ title: tr('正式方案已建立'), tone: 'success' }),
                onError: (e) => toast({ title: errorText(e, tr('建立方案')), tone: 'danger' }),
              },
            )
          }
        >
          {tr('建立方案')}
        </Button>
      </div>
    </section>
  );
}

function VersionHistory({ pid, planId }: { pid: string; planId: string }) {
  const query = usePlanVersions(pid, planId);
  return (
    <section className="min-w-0">
      <h2 className="mb-2 text-h3 text-fg">{tr('历史版本')}</h2>
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={tr('正在加载历史版本')}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <LoadError
          message={tr('历史版本没能加载出来：{message}', { message: query.error.message })}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.length === 0 ? (
        <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
          {tr('还没有历史版本')}
        </p>
      ) : (
        <ul className="research-list" aria-label={tr('历史版本')}>
          {query.data.map((v, i) => (
            <VersionRow key={v.id} version={v} previous={query.data[i + 1]} />
          ))}
        </ul>
      )}
    </section>
  );
}

function VersionRow({
  version,
  previous,
}: {
  version: PlanVersion;
  previous?: PlanVersion | undefined;
}) {
  const [open, setOpen] = useState(false);
  const before = previous?.content ?? '';
  const stats = diffStats(lineDiff(before, version.content));
  return (
    <li className="research-row min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left"
      >
        <span className="w-10 shrink-0 text-small font-medium text-fg tabular-nums">
          v{version.version}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-small text-fg">
            {version.note || tr('未写说明')}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-2 text-caption text-fg-subtle">
            <span>
              {tr('审批人 ')}
              {version.approvedBy ? trServer(version.approvedBy.name) : tr('无（初始版本）')}
            </span>
            <RelativeTime iso={version.createdAt} />
            <span className="text-success tabular-nums">+{stats.added}</span>
            <span className="text-danger tabular-nums">−{stats.removed}</span>
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
        <div className="px-3 pb-3">
          {previous ? (
            <PlanDiff
              before={before}
              after={version.content}
              caption={tr('相对第 {version} 版', { version: previous.version })}
            />
          ) : (
            <>
              <DiffStatsLine added={stats.added} removed={0} caption={tr('初始版本')} />
              <div className="rounded-md border border-line bg-surface p-3">
                <Markdown size="compact">{version.content || tr('（空）')}</Markdown>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
