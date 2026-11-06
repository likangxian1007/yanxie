import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import type { ResearchRecord, ResearchSourceKind } from '@srh/shared';
import { Badge, Button, EmptyState, Select, Skeleton } from '@/components/ui';
import { researchApi, researchKey, useResearchSources } from '../data';
import { NewSourceDialog } from '../pages/ResearchSourcesPage';
import { tr } from '@/lib/i18n';

const SOURCE_KIND_LABEL: Record<ResearchSourceKind, string> = {
  file: tr('项目文件'),
  document: tr('文档'),
  paper: tr('论文'),
  notebook: 'Notebook',
  bibliography: tr('手工书目'),
  url: tr('网址'),
};

export function MaterialsSection({
  pid,
  record,
  writable,
}: {
  pid: string;
  record: ResearchRecord;
  writable: boolean;
}) {
  const qc = useQueryClient();
  const sources = useResearchSources(pid);
  const [sourceId, setSourceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const linked = (sources.data ?? []).filter((source) => record.sourceIds.includes(source.id));
  const available = (sources.data ?? []).filter(
    (source) => !record.sourceIds.includes(source.id) && !source.archivedAt,
  );
  const update = async (ids: string[]) => {
    setPending(true);
    setError('');
    try {
      await researchApi.updateRecord(pid, record.id, {
        sourceIds: ids,
        baseVersion: record.version,
      });
      await qc.invalidateQueries({ queryKey: researchKey(pid) });
      setSourceId('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : tr('关联没有保存，请重新读取研究空间后重试。'),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-5" aria-label={tr('研究材料')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-h2 text-fg">{tr('资料与原件')}</h2>
        <Link
          to={`/p/${pid}/research-sources`}
          className="text-small text-accent-text hover:underline"
        >
          {tr('查看全部资料')}
        </Link>
      </div>
      {sources.isPending ? (
        <Skeleton className="h-24" />
      ) : sources.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title={tr('资料没有加载出来')}
          description={sources.error.message}
          action={
            <Button variant="secondary" onClick={() => void sources.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : linked.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-small text-fg-muted">
          {tr('这项研究还没有关联资料。')}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {linked.map((source) => (
            <li key={source.id} className="flex min-w-0 flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/p/${pid}/research-sources/${source.id}`}
                  className="block truncate text-small font-medium text-accent-text hover:underline"
                >
                  {source.title}
                </Link>
                <span className="text-caption text-fg-muted">
                  {SOURCE_KIND_LABEL[source.kind]}
                  {source.citation && ` · ${source.citation}`}
                </span>
              </div>
              {source.needsReview && <Badge tone="warning">{tr('待复核')}</Badge>}
              {writable && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void update(record.sourceIds.filter((id) => id !== source.id))}
                >
                  {tr('移除关联')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {writable && (
        <div className="flex flex-wrap gap-2">
          <div className="min-w-48 flex-1">
            <Select
              aria-label={tr('选择现有资料')}
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">{tr('选择课题资料')}</option>
              {available.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="secondary"
            disabled={!sourceId || pending}
            loading={pending}
            onClick={() => void update([...record.sourceIds, sourceId])}
          >
            {tr('关联资料')}
          </Button>
          <Button
            variant="secondary"
            leftIcon={<Plus size={16} />}
            onClick={() => setCreating(true)}
          >
            {tr('添加资料')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      <NewSourceDialog open={creating} onOpenChange={setCreating} pid={pid} recordId={record.id} />
    </section>
  );
}
