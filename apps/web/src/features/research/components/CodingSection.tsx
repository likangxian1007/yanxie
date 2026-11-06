import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Tags } from 'lucide-react';
import type { ResearchCode } from '@srh/shared';
import { Badge, Button, EmptyState, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useListQueryState } from '@/lib/list-state';
import { researchApi, researchKey, useResearchRows } from '../data';
import { tr } from '@/lib/i18n';

export function CodingSection({
  pid,
  recordId,
  writable,
}: {
  pid: string;
  recordId: string;
  writable: boolean;
}) {
  const qc = useQueryClient();
  const codes = useResearchRows(pid, recordId, 'codes', (signal) =>
    researchApi.codes(pid, recordId, signal),
  );
  const excerpts = useResearchRows(pid, recordId, 'excerpts', (signal) =>
    researchApi.excerpts(pid, recordId, signal),
  );
  const codings = useResearchRows(pid, recordId, 'codings', (signal) =>
    researchApi.codings(pid, recordId, signal),
  );
  const [caseFilter, setCaseFilter] = useListQueryState('case', 'all');
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [group, setGroup] = useState('');
  const [editing, setEditing] = useState<ResearchCode | null>(null);
  const [excerptId, setExcerptId] = useState('');
  const [codeId, setCodeId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const cases = [
    ...new Set(
      (codings.data ?? []).map((coding) => coding.caseId).filter((id): id is string => !!id),
    ),
  ].sort();
  const shown = (codings.data ?? []).filter(
    (coding) => caseFilter === 'all' || coding.caseId === caseFilter,
  );
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: researchKey(pid, 'record', recordId) });
  };
  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(tr('请填写编码名称。'));
      return;
    }
    setPending(true);
    setError('');
    try {
      if (editing)
        await researchApi.updateCode(pid, editing.id, {
          name: name.trim(),
          definition: definition.trim(),
          group: group.trim() || null,
          baseVersion: editing.version,
        });
      else
        await researchApi.createCode(pid, recordId, {
          name: name.trim(),
          definition: definition.trim(),
          group: group.trim() || null,
        });
      setEditing(null);
      setName('');
      setDefinition('');
      setGroup('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('编码没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };
  const submitCoding = async (event: FormEvent) => {
    event.preventDefault();
    if (!excerptId || !codeId) {
      setError(tr('请选择摘录与编码主题。'));
      return;
    }
    setPending(true);
    setError('');
    try {
      await researchApi.createCoding(pid, recordId, {
        excerptId,
        codeId,
        caseId: caseId.trim() || null,
      });
      setExcerptId('');
      setCodeId('');
      setCaseId('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('标注没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-label={tr('编码本')}>
        <h2 className="text-h2 text-fg">{tr('编码本')}</h2>
        {codes.isPending ? (
          <Skeleton className="h-20" />
        ) : codes.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title={tr('编码本没有加载出来')}
            description={codes.error.message}
            action={
              <Button variant="secondary" onClick={() => void codes.refetch()}>
                {tr('重试')}
              </Button>
            }
          />
        ) : codes.data.length === 0 ? (
          <EmptyState
            icon={Tags}
            title={tr('还没有编码主题')}
            description={tr('先定义主题，再把摘录标注到主题上。')}
          />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {codes.data.map((code) => (
              <li key={code.id} className="flex flex-wrap items-start gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-small font-medium text-fg">{code.name}</div>
                  {code.definition && (
                    <p className="mt-1 text-small text-fg-muted">{code.definition}</p>
                  )}
                </div>
                {code.group && <Badge>{code.group}</Badge>}
                {writable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(code);
                      setName(code.name);
                      setDefinition(code.definition);
                      setGroup(code.group ?? '');
                    }}
                  >
                    {tr('编辑')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {writable && (
          <form
            className="space-y-3 rounded-lg border border-line bg-surface p-4"
            onSubmit={submitCode}
          >
            <h3 className="text-h3 text-fg">{editing ? tr('编辑编码') : tr('新建编码')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-small text-fg">
                {tr('主题名称')}
                <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block space-y-1.5 text-small text-fg">
                {tr('分组')}
                <Input
                  value={group}
                  maxLength={160}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder={tr('例如：服务体验')}
                />
              </label>
            </div>
            <label className="block space-y-1.5 text-small text-fg">
              {tr('定义')}
              <Textarea
                value={definition}
                maxLength={4000}
                rows={2}
                onChange={(e) => setDefinition(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <Button variant="primary" type="submit" loading={pending}>
                {editing ? tr('保存编码') : tr('创建编码')}
              </Button>
              {editing && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(null);
                    setName('');
                    setDefinition('');
                    setGroup('');
                  }}
                >
                  {tr('取消编辑')}
                </Button>
              )}
            </div>
          </form>
        )}
      </section>
      <section className="space-y-4" aria-label={tr('摘录编码')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-h2 text-fg">{tr('摘录标注')}</h2>
          <Select
            aria-label={tr('按对象代号筛选')}
            value={caseFilter}
            onChange={(e) => setCaseFilter(e.target.value)}
            wrapperClassName="w-auto min-w-32"
          >
            <option value="all">{tr('全部对象')}</option>
            {cases.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </div>
        {codings.isPending ? (
          <Skeleton className="h-20" />
        ) : codings.isError ? (
          <p role="alert" className="text-small text-danger">
            {tr('标注没有加载出来。')}
            <Button size="sm" variant="ghost" onClick={() => void codings.refetch()}>
              {tr('重试')}
            </Button>
          </p>
        ) : shown.length === 0 ? (
          <p className="text-small text-fg-muted">
            {caseFilter === 'all' ? tr('还没有摘录标注。') : tr('这个对象还没有标注。')}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {shown.map((coding) => {
              const code = codes.data?.find((item) => item.id === coding.codeId);
              const excerpt = excerpts.data?.find((item) => item.id === coding.excerptId);
              return (
                <li key={coding.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{code?.name ?? coding.codeId}</Badge>
                    {coding.caseId && (
                      <Badge>{tr('对象 {caseId}', { caseId: coding.caseId })}</Badge>
                    )}
                  </div>
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-small text-fg">
                    {excerpt?.quote ?? tr('原摘录暂不可用')}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        {writable && (
          <form
            className="space-y-3 rounded-lg border border-line bg-surface p-4"
            onSubmit={submitCoding}
          >
            <h3 className="text-h3 text-fg">{tr('给摘录打码')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-small text-fg">
                {tr('摘录')}
                <Select value={excerptId} onChange={(e) => setExcerptId(e.target.value)}>
                  <option value="">{tr('选择摘录')}</option>
                  {(excerpts.data ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.quote.slice(0, 80)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block space-y-1.5 text-small text-fg">
                {tr('编码主题')}
                <Select value={codeId} onChange={(e) => setCodeId(e.target.value)}>
                  <option value="">{tr('选择主题')}</option>
                  {(codes.data ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <label className="block space-y-1.5 text-small text-fg">
              {tr('对象代号（可选）')}
              <Input
                value={caseId}
                maxLength={160}
                onChange={(e) => setCaseId(e.target.value)}
                placeholder={tr('例如：受访者 A；与主题分开')}
              />
            </label>
            <Button variant="primary" type="submit" loading={pending}>
              {tr('保存标注')}
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
