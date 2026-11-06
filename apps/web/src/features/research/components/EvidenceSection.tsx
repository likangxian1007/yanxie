import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Quote } from 'lucide-react';
import type { EvidenceLocator, EvidenceOrigin } from '@srh/shared';
import { Badge, Button, EmptyState, Input, Select, Skeleton, Textarea } from '@/components/ui';
import {
  researchApi,
  researchKey,
  useResearchRecord,
  useResearchRows,
  useResearchSources,
} from '../data';
import { tr, trServer } from '@/lib/i18n';

const ORIGINS: Record<EvidenceOrigin, string> = {
  member_report: tr('成员记录'),
  observation: tr('现场观察'),
  tool_result: tr('工具结果'),
  ai_extraction: tr('AI 提取'),
  manual: tr('手工摘录'),
};
type LocatorKind = EvidenceLocator['kind'];
const LOCATORS: Record<LocatorKind, string> = {
  pdf: tr('PDF 页码'),
  text: tr('文本段落'),
  sheet: tr('表格范围'),
  manual: tr('手工定位'),
};

export function EvidenceSection({
  pid,
  recordId,
  writable,
}: {
  pid: string;
  recordId: string;
  writable: boolean;
}) {
  const qc = useQueryClient();
  const detail = useResearchRecord(pid, recordId);
  const sources = useResearchSources(pid);
  const excerpts = useResearchRows(pid, recordId, 'excerpts', (signal) =>
    researchApi.excerpts(pid, recordId, signal),
  );
  const [sourceId, setSourceId] = useState('');
  const [snapshotId, setSnapshotId] = useState('');
  const snapshots = useQuery({
    queryKey: researchKey(pid, 'source', sourceId, 'snapshots'),
    queryFn: ({ signal }) => researchApi.snapshots(pid, sourceId, signal),
    enabled: !!sourceId,
  });
  const [quote, setQuote] = useState('');
  const [origin, setOrigin] = useState<EvidenceOrigin>('manual');
  const [locatorKind, setLocatorKind] = useState<LocatorKind>('manual');
  const [page, setPage] = useState('');
  const [paragraph, setParagraph] = useState('');
  const [sheet, setSheet] = useState('');
  const [range, setRange] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const linked = (sources.data ?? []).filter((source) =>
    detail.data?.record.sourceIds.includes(source.id),
  );
  const citedSourceIds = [
    ...new Set([
      ...linked.map((source) => source.id),
      ...(excerpts.data ?? []).map((item) => item.sourceId),
    ]),
  ];
  const sourceSnapshots = useQueries({
    queries: citedSourceIds.map((id) => ({
      queryKey: researchKey(pid, 'source', id, 'snapshots'),
      queryFn: ({ signal }: { signal: AbortSignal }) => researchApi.snapshots(pid, id, signal),
    })),
  });
  const snapshotById = new Map(
    sourceSnapshots.flatMap((query) => query.data ?? []).map((item) => [item.id, item]),
  );
  const snapshot = snapshots.data?.find((item) => item.id === snapshotId);
  const locator = (): EvidenceLocator | null => {
    if (locatorKind === 'pdf') return Number(page) > 0 ? { kind: 'pdf', page: Number(page) } : null;
    if (locatorKind === 'text')
      return Number(paragraph) > 0 ? { kind: 'text', paragraph: Number(paragraph) } : null;
    if (locatorKind === 'sheet')
      return sheet.trim() && range.trim()
        ? { kind: 'sheet', sheet: sheet.trim(), range: range.trim() }
        : null;
    return note.trim() ? { kind: 'manual', note: note.trim() } : null;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const location = locator();
    if (!sourceId || !snapshotId || !quote.trim() || !location) {
      setError(tr('请选择资料与快照、填写原文和具体位置。'));
      return;
    }
    setPending(true);
    setError('');
    try {
      await researchApi.createExcerpt(pid, recordId, {
        sourceId,
        snapshotId,
        quote: quote.trim(),
        locator: location,
        origin,
      });
      setQuote('');
      setNote('');
      await qc.invalidateQueries({ queryKey: researchKey(pid, 'record', recordId, 'excerpts') });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('摘录没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-5" aria-label={tr('证据摘录')}>
      <h2 className="text-h2 text-fg">{tr('证据摘录')}</h2>
      {excerpts.isPending ? (
        <Skeleton className="h-24" />
      ) : excerpts.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title={tr('摘录没有加载出来')}
          description={excerpts.error.message}
          action={
            <Button variant="secondary" onClick={() => void excerpts.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : excerpts.data.length === 0 ? (
        <EmptyState
          icon={Quote}
          title={tr('还没有证据摘录')}
          description={tr('先给研究空间关联资料并创建快照，再固定原文和位置。')}
        />
      ) : (
        <ul className="space-y-3">
          {excerpts.data.map((excerpt) => {
            const citedSnapshot = snapshotById.get(excerpt.snapshotId);
            const coverage = citedSnapshot?.coverage;
            return (
              <li key={excerpt.id} className="rounded-lg border border-line bg-surface p-4">
                <blockquote className="whitespace-pre-wrap text-prose text-fg">
                  {excerpt.quote}
                </blockquote>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-caption text-fg-muted">
                  <Link
                    className="text-accent-text hover:underline"
                    to={`/p/${pid}/research-sources/${excerpt.sourceId}`}
                  >
                    {citedSnapshot?.sourceMetadata.title ?? tr('查看资料')}
                  </Link>
                  {citedSnapshot && (
                    <span>
                      {tr('来源第 {sourceVersion} 版{value}', {
                        sourceVersion: citedSnapshot.sourceVersion,
                        value:
                          citedSnapshot.sourceMetadata.citation &&
                          ` · ${citedSnapshot.sourceMetadata.citation}`,
                      })}
                    </span>
                  )}
                  <span>·</span>
                  {coverage && coverage !== 'external' ? (
                    <a
                      className="text-accent-text hover:underline"
                      href={researchApi.snapshotUrl(pid, excerpt.snapshotId)}
                      download
                      title={tr('快照 {snapshotId}', { snapshotId: excerpt.snapshotId })}
                    >
                      {tr('查看引用版本')}
                    </a>
                  ) : coverage === 'external' ? (
                    <span>{tr('引用版本仅存来源元数据')}</span>
                  ) : (
                    <span>{tr('正在读取引用版本…')}</span>
                  )}
                  <span>·</span>
                  {coverage && (
                    <Badge>
                      {coverage === 'complete'
                        ? tr('完整原件')
                        : coverage === 'excerpt'
                          ? tr('仅摘录')
                          : tr('仅链接')}
                    </Badge>
                  )}
                  <span>
                    {LOCATORS[excerpt.locator.kind]}
                    {tr('：')}
                    {excerpt.locator.kind === 'pdf'
                      ? tr('第 {page} 页', { page: excerpt.locator.page })
                      : excerpt.locator.kind === 'text'
                        ? tr('第 {paragraph} 段', { paragraph: excerpt.locator.paragraph })
                        : excerpt.locator.kind === 'sheet'
                          ? `${excerpt.locator.sheet}!${excerpt.locator.range}`
                          : excerpt.locator.note}
                  </span>
                  <Badge tone={excerpt.verification === 'verified' ? 'success' : 'warning'}>
                    {excerpt.verification === 'verified'
                      ? tr('与保存快照匹配')
                      : tr('未经快照核对')}
                  </Badge>
                  <Badge tone={excerpt.origin === 'ai_extraction' ? 'agent' : 'neutral'}>
                    {ORIGINS[excerpt.origin]}
                  </Badge>
                  <span>{tr('摘录人：{name}', { name: trServer(excerpt.createdBy.name) })}</span>
                </div>
                <details className="mt-2 text-caption text-fg-muted">
                  <summary className="cursor-pointer">{tr('引用标识')}</summary>
                  <p className="mt-1 break-all font-mono">
                    {tr('摘录 {id} · 快照 {snapshotId}', {
                      id: excerpt.id,
                      snapshotId: excerpt.snapshotId,
                    })}
                  </p>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {writable && (
        <form className="space-y-4 rounded-lg border border-line bg-surface p-4" onSubmit={submit}>
          <h3 className="text-h3 text-fg">{tr('添加摘录')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-small text-fg">
              {tr('关联资料')}
              <Select
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setSnapshotId('');
                }}
              >
                <option value="">{tr('选择资料')}</option>
                {linked.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.title}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block space-y-1.5 text-small text-fg">
              {tr('固定快照')}
              <Select
                value={snapshotId}
                disabled={!sourceId || snapshots.isPending}
                onChange={(e) => setSnapshotId(e.target.value)}
              >
                <option value="">{tr('选择版本快照')}</option>
                {(snapshots.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.createdAt.slice(0, 10)} ·{' '}
                    {item.coverage === 'complete'
                      ? tr('完整原件')
                      : item.coverage === 'excerpt'
                        ? tr('仅摘录')
                        : tr('仅链接')}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          {sourceId && snapshots.data?.length === 0 && (
            <p className="text-small text-fg-muted">
              {tr('此资料还没有快照。')}
              <Link
                className="text-accent-text hover:underline"
                to={`/p/${pid}/research-sources/${sourceId}`}
              >
                {tr('去创建快照')}
              </Link>
            </p>
          )}
          {snapshot && (
            <p className="text-caption text-fg-muted">
              {tr('选定的版本：')}
              {snapshot.coverage === 'complete'
                ? tr('完整原件')
                : snapshot.coverage === 'excerpt'
                  ? tr('仅保存摘录')
                  : tr('仅外部链接')}
              {tr('。保存摘录后引用仍指向此版本。')}
            </p>
          )}
          <label className="block space-y-1.5 text-small text-fg">
            {tr('原文')}
            <Textarea
              rows={4}
              value={quote}
              maxLength={20000}
              onChange={(e) => setQuote(e.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-small text-fg">
              {tr('提取方式')}
              <Select value={origin} onChange={(e) => setOrigin(e.target.value as EvidenceOrigin)}>
                {Object.entries(ORIGINS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block space-y-1.5 text-small text-fg">
              {tr('定位方式')}
              <Select
                value={locatorKind}
                onChange={(e) => setLocatorKind(e.target.value as LocatorKind)}
              >
                {Object.entries(LOCATORS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          {locatorKind === 'pdf' && (
            <label className="block space-y-1.5 text-small text-fg">
              {tr('页码')}
              <Input type="number" min={1} value={page} onChange={(e) => setPage(e.target.value)} />
            </label>
          )}
          {locatorKind === 'text' && (
            <label className="block space-y-1.5 text-small text-fg">
              {tr('段落序号')}
              <Input
                type="number"
                min={1}
                value={paragraph}
                onChange={(e) => setParagraph(e.target.value)}
              />
            </label>
          )}
          {locatorKind === 'sheet' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-small text-fg">
                {tr('工作表')}
                <Input value={sheet} onChange={(e) => setSheet(e.target.value)} />
              </label>
              <label className="block space-y-1.5 text-small text-fg">
                {tr('区域')}
                <Input
                  value={range}
                  placeholder="A1:C8"
                  onChange={(e) => setRange(e.target.value)}
                />
              </label>
            </div>
          )}
          {locatorKind === 'manual' && (
            <label className="block space-y-1.5 text-small text-fg">
              {tr('位置说明')}
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={tr('例如：访谈 02，42 分钟处')}
              />
            </label>
          )}
          <p className="text-caption text-fg-muted">
            {tr('验证状态只表示与已保存快照匹配，不证明外部原件真实；手工定位不等于已核对。')}
          </p>
          {error && (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" loading={pending}>
            {tr('保存摘录')}
          </Button>
        </form>
      )}
    </section>
  );
}
