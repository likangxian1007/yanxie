import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Lightbulb } from 'lucide-react';
import type { EvidenceExcerpt, ResearchFinding } from '@srh/shared';
import { Badge, Button, EmptyState, Skeleton, Textarea } from '@/components/ui';
import { RequestReviewDialog } from '@/features/reviews/components/RequestReviewDialog';
import { researchApi, researchKey, useResearchRows } from '../data';
import { tr, trServer } from '@/lib/i18n';

type Role = 'supportingExcerptIds' | 'counterExcerptIds' | 'contextExcerptIds';
const ROLE_LABEL: Record<Role, string> = {
  supportingExcerptIds: tr('支持依据'),
  counterExcerptIds: tr('反例依据'),
  contextExcerptIds: tr('背景依据'),
};
const ROLES = Object.keys(ROLE_LABEL) as Role[];

function EvidenceChoices({
  excerpts,
  selected,
  onChange,
}: {
  excerpts: EvidenceExcerpt[];
  selected: Record<Role, string[]>;
  onChange: (next: Record<Role, string[]>) => void;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {ROLES.map((role) => (
        <fieldset key={role} className="space-y-2 rounded-md border border-line p-3">
          <legend className="px-1 text-small font-medium text-fg">{ROLE_LABEL[role]}</legend>
          <div className="max-h-48 space-y-2 overflow-y-auto">
            {excerpts.length === 0 ? (
              <p className="text-caption text-fg-muted">{tr('暂无摘录')}</p>
            ) : (
              excerpts.map((excerpt) => (
                <label key={excerpt.id} className="flex items-start gap-2 text-small text-fg">
                  <input
                    type="checkbox"
                    checked={selected[role].includes(excerpt.id)}
                    onChange={(e) =>
                      onChange({
                        ...selected,
                        [role]: e.target.checked
                          ? [...selected[role], excerpt.id]
                          : selected[role].filter((id) => id !== excerpt.id),
                      })
                    }
                  />
                  <span className="line-clamp-3">{excerpt.quote}</span>
                </label>
              ))
            )}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export function FindingsSection({
  pid,
  recordId,
  writable,
}: {
  pid: string;
  recordId: string;
  writable: boolean;
}) {
  const qc = useQueryClient();
  const findings = useResearchRows(pid, recordId, 'findings', (signal) =>
    researchApi.findings(pid, recordId, signal),
  );
  const excerpts = useResearchRows(pid, recordId, 'excerpts', (signal) =>
    researchApi.excerpts(pid, recordId, signal),
  );
  const [editing, setEditing] = useState<ResearchFinding | null>(null);
  const [statement, setStatement] = useState('');
  const [limitations, setLimitations] = useState('');
  const [selected, setSelected] = useState<Record<Role, string[]>>({
    supportingExcerptIds: [],
    counterExcerptIds: [],
    contextExcerptIds: [],
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState<ResearchFinding | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: researchKey(pid, 'record', recordId, 'findings') });
  };
  const startEdit = (finding: ResearchFinding) => {
    setEditing(finding);
    setStatement(finding.statement);
    setLimitations(finding.limitations);
    setSelected({
      supportingExcerptIds: finding.supportingExcerptIds,
      counterExcerptIds: finding.counterExcerptIds,
      contextExcerptIds: finding.contextExcerptIds,
    });
    setError('');
  };
  const reset = () => {
    setEditing(null);
    setStatement('');
    setLimitations('');
    setSelected({ supportingExcerptIds: [], counterExcerptIds: [], contextExcerptIds: [] });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!statement.trim()) {
      setError(tr('请写下结论陈述。'));
      return;
    }
    setPending(true);
    setError('');
    try {
      const input = { statement: statement.trim(), limitations: limitations.trim(), ...selected };
      if (editing)
        await researchApi.updateFinding(pid, editing.id, {
          ...input,
          baseVersion: editing.version,
        });
      else await researchApi.createFinding(pid, recordId, { ...input, humanConfirmed: false });
      reset();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('结论没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };
  const confirm = async (finding: ResearchFinding) => {
    setPending(true);
    setError('');
    try {
      await researchApi.updateFinding(pid, finding.id, {
        humanConfirmed: true,
        resolveReview: finding.needsReview,
        baseVersion: finding.version,
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('确认没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };
  const byId = new Map((excerpts.data ?? []).map((excerpt) => [excerpt.id, excerpt]));

  return (
    <section className="space-y-5" aria-label={tr('研究结论')}>
      <h2 className="text-h2 text-fg">{tr('分析与结论')}</h2>
      {findings.isPending ? (
        <Skeleton className="h-24" />
      ) : findings.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title={tr('结论没有加载出来')}
          description={findings.error.message}
          action={
            <Button variant="secondary" onClick={() => void findings.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : findings.data.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title={tr('还没有结论')}
          description={tr('把支持依据、反例和局限放在一起，便于审阅。')}
        />
      ) : (
        <ul className="space-y-3">
          {findings.data.map((finding) => (
            <li key={finding.id} className="space-y-3 rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    finding.humanConfirmed
                      ? 'success'
                      : finding.createdBy.kind === 'agent'
                        ? 'agent'
                        : 'neutral'
                  }
                >
                  {finding.humanConfirmed
                    ? tr('人工已确认')
                    : finding.createdBy.kind === 'agent'
                      ? tr('AI 草稿')
                      : tr('未确认')}
                </Badge>
                {finding.needsReview && <Badge tone="warning">{tr('依据更新待复核')}</Badge>}
                <span className="text-caption text-fg-muted">
                  {tr('第 {version} 版 · {name}', {
                    version: finding.version,
                    name: trServer(finding.createdBy.name),
                  })}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-prose text-fg">{finding.statement}</p>
              {finding.limitations && (
                <p className="text-small text-fg-muted">
                  {tr('局限：{limitations}', { limitations: finding.limitations })}
                </p>
              )}
              {ROLES.map(
                (role) =>
                  finding[role].length > 0 && (
                    <div key={role} className="text-small">
                      <span className="font-medium text-fg">
                        {tr('{value}：', { value: ROLE_LABEL[role] })}
                      </span>
                      {finding[role].map((id) => {
                        const excerpt = byId.get(id);
                        return excerpt ? (
                          <Link
                            key={id}
                            className="mr-2 text-accent-text hover:underline"
                            to={`/p/${pid}/research-sources/${excerpt.sourceId}`}
                            title={excerpt.quote}
                          >
                            {excerpt.quote.slice(0, 24)}
                          </Link>
                        ) : (
                          <span key={id} className="mr-2 text-fg-muted">
                            {tr('摘录 {id} 已不可用', { id })}
                          </span>
                        );
                      })}
                    </div>
                  ),
              )}
              {writable && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(finding)}>
                    {tr('编辑结论')}
                  </Button>
                  {(!finding.humanConfirmed || finding.needsReview) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => void confirm(finding)}
                    >
                      {finding.needsReview ? tr('核对依据并确认') : tr('人工确认')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setReviewing(finding)}>
                    {tr('请求审阅')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {writable && (
        <form className="space-y-4 rounded-lg border border-line bg-surface p-4" onSubmit={submit}>
          <h3 className="text-h3 text-fg">{editing ? tr('编辑结论') : tr('新增结论')}</h3>
          <label className="block space-y-1.5 text-small text-fg">
            {tr('结论陈述')}
            <Textarea
              value={statement}
              maxLength={20000}
              rows={4}
              onChange={(e) => setStatement(e.target.value)}
            />
          </label>
          <EvidenceChoices
            excerpts={excerpts.data ?? []}
            selected={selected}
            onChange={setSelected}
          />
          <label className="block space-y-1.5 text-small text-fg">
            {tr('局限与不确定性')}
            <Textarea
              value={limitations}
              maxLength={10000}
              rows={3}
              onChange={(e) => setLimitations(e.target.value)}
            />
          </label>
          <p className="text-caption text-fg-muted">
            {tr('新结论先保存为未确认；人工确认是独立操作。')}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" type="submit" loading={pending}>
              {editing ? tr('保存修改') : tr('保存结论')}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={reset}>
                {tr('取消编辑')}
              </Button>
            )}
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {reviewing && (
        <RequestReviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setReviewing(null);
          }}
          defaultTarget={{
            kind: 'research_finding',
            id: reviewing.id,
            title: reviewing.statement.slice(0, 60),
          }}
        />
      )}
    </section>
  );
}
