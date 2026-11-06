import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Report } from '@srh/shared';
import { Check, CircleAlert } from 'lucide-react';
import { Button, Spinner, Tabs, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { SyncStatus } from '@/features/collab-kit/conflict/field-sync';
import { SyncNotice } from '@/features/collab-kit/conflict/SyncNotice';
import { useFieldSync, useWarnBeforeUnload } from '@/features/collab-kit/conflict/use-field-sync';
import { reportSync } from '../api';
import { ReportMarkdown } from './ReportMarkdown';
import { tr } from '@/lib/i18n';

/**
 * 草稿编辑：lg 以上左右分栏（左 markdown、右预览），窄屏 Tabs 切换。
 * 停止输入 1s 后自动保存（PATCH content + baseVersion）。
 * 别人改了正文：没在改就跟随；正在改就保留自己的输入并提示，保存撞上 409 时给合并视图。
 */
export function ReportEditor({ pid, report }: { pid: string; report: Report }) {
  const qc = useQueryClient();
  const sync = useMemo(() => reportSync(qc, pid, report.id), [qc, pid, report.id]);
  useFieldSync(sync, report);
  useWarnBeforeUnload(sync.hasUnsaved());
  // 窄屏（< lg）一次只显示一栏：已有内容时先给排好版的预览（手机上多半是来读的），空稿直接进编辑
  const [tab, setTab] = useState<'edit' | 'preview'>(() =>
    report.content.trim() ? 'preview' : 'edit',
  );
  const field = sync.field('content', report);
  const text = field.value;

  // 离开页面时把还没来得及保存的改动发出去（冲突留在同步器里，回来还能处理）
  useEffect(() => () => void sync.flush(), [sync]);

  const status = (
    <SaveStatus status={sync.status} dirty={field.dirty} onRetry={() => void sync.flush()} />
  );

  return (
    <div>
      <SyncNotice sync={sync} field="content" label={tr('正文')} manual className="mb-4" />
      <div className="mb-3 flex items-center justify-between gap-3 lg:hidden">
        <Tabs
          variant="segmented"
          value={tab}
          onValueChange={setTab}
          layoutId="report-editor-tab"
          aria-label={tr('编辑或预览')}
          items={[
            { value: 'edit', label: tr('编辑') },
            { value: 'preview', label: tr('预览') },
          ]}
        />
        {status}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className={cn('min-w-0', tab === 'preview' && 'hidden lg:block')}>
          <div className="mb-2 hidden items-center justify-between lg:flex">
            <span className="text-caption text-fg-subtle">Markdown</span>
            {status}
          </div>
          <Textarea
            autoGrow
            aria-label={tr('汇报正文（Markdown）')}
            value={text}
            onChange={(e) => sync.edit('content', e.target.value)}
            onBlur={() => void sync.flush()}
            spellCheck={false}
            placeholder={tr('## 本周进展\n\n- …\n\n## 下周计划\n\n- …')}
            className="max-h-none min-h-[60vh] font-mono text-small leading-relaxed"
          />
        </div>
        <div className={cn('min-w-0', tab === 'edit' && 'hidden lg:block')}>
          <div className="mb-2 hidden lg:block">
            <span className="text-caption text-fg-subtle">{tr('预览')}</span>
          </div>
          <div className="rounded-lg border border-line bg-surface px-5 py-4 lg:sticky lg:top-16 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
            {text.trim() ? (
              <ReportMarkdown pid={pid}>{text}</ReportMarkdown>
            ) : (
              <p className="text-small text-fg-subtle">{tr('左边写下内容，这里实时预览。')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SaveStatus({
  status,
  dirty,
  onRetry,
}: {
  status: SyncStatus;
  dirty: boolean;
  onRetry: () => void;
}) {
  if (status === 'conflict') {
    return (
      <span className="flex items-center gap-1.5 text-caption text-warning" role="status">
        <CircleAlert size={14} strokeWidth={1.75} aria-hidden />
        {tr('有冲突待处理')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-caption text-danger" role="status">
        <CircleAlert size={14} strokeWidth={1.75} aria-hidden />
        {tr('保存失败')}
        <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={onRetry}>
          {tr('重试')}
        </Button>
      </span>
    );
  }
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-caption text-fg-subtle" role="status">
        <Spinner size={12} />
        {tr('正在保存…')}
      </span>
    );
  }
  if (dirty) {
    return (
      <span className="text-caption text-fg-subtle" role="status">
        {tr('有未保存的改动')}
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1 text-caption text-fg-subtle" role="status">
        <Check size={14} strokeWidth={1.75} aria-hidden className="text-success" />
        {tr('已保存')}
      </span>
    );
  }
  return <span className="text-caption text-fg-subtle">{tr('自动保存')}</span>;
}

/** 只读预览（定稿后 / 没有编辑权限） */
export function ReportReader({ pid, content }: { pid: string; content: string }) {
  return (
    <article className="mx-auto w-full max-w-(--doc-max)">
      {content.trim() ? (
        <ReportMarkdown pid={pid}>{content}</ReportMarkdown>
      ) : (
        <p className="text-small text-fg-muted">{tr('这份汇报还没有内容。')}</p>
      )}
    </article>
  );
}
