import { useState } from 'react';
import type { PaperQaTurn, PaperQaPublishPreview, PaperQaPublishSelection } from '@srh/shared';
import { Button, Select } from '@/components/ui';
import { qaApi } from '../qa-api';
import type { PersonalLibrary } from '../lib/scope';
import { tr, trServer } from '@/lib/i18n';
export function QaPublicationPicker({
  scope,
  paperId,
  projectId,
  targetPaperId,
  disabled,
  onChange,
}: {
  scope: PersonalLibrary;
  paperId: string;
  projectId: string;
  targetPaperId?: string;
  disabled: boolean;
  onChange: (s: PaperQaPublishSelection[] | null) => void;
}) {
  const [rows, setRows] = useState<(PaperQaTurn & { sessionTitle: string })[] | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [policy, setPolicy] = useState<'mark' | 'remove'>('mark'),
    [preview, setPreview] = useState<PaperQaPublishPreview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [ack, setAck] = useState(false);
  const hasMissing = Boolean(preview?.turns.some((t) => t.missingContext.length));
  const invalidate = () => {
    setPreview(null);
    setAck(false);
    onChange(null);
  };
  const selections = (p: PaperQaPublishPreview, allow: boolean): PaperQaPublishSelection[] =>
    p.turns.map((t) => ({
      id: t.id,
      version: t.version,
      unsharedSources: policy,
      allowMissingContext: allow,
      previewHash: t.previewHash,
    }));
  return (
    <section className="space-y-3">
      <Button
        variant="secondary"
        disabled={disabled}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const sessions = await qaApi.sessions(scope, paperId);
            const all = await Promise.all(
              sessions.map(async (s) =>
                (await qaApi.turns(scope, paperId, s.id))
                  .filter((t) => t.status === 'done')
                  .map((t) => ({ ...t, sessionTitle: s.title })),
              ),
            );
            setRows(all.flat());
            if (selected.length) invalidate();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {rows ? tr('刷新问答列表') : tr('选择要发布的问答')}
      </Button>
      {rows && (
        <>
          <p className="text-small font-medium">{tr('只发布勾选的问题与回答（默认全不选）')}</p>
          {rows.length === 0 && (
            <p className="text-small text-fg-muted">{tr('还没有已完成的问答。')}</p>
          )}
          {rows.map((t) => (
            <label key={t.id} className="flex min-h-11 items-start gap-2 text-small wrap-anywhere">
              <input
                type="checkbox"
                className="mt-1"
                disabled={disabled || busy}
                checked={selected.includes(t.id)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, t.id]
                    : selected.filter((id) => id !== t.id);
                  setSelected(next);
                  invalidate();
                  if (!next.length) onChange([]);
                }}
              />
              <span>
                {t.sessionTitle} · {t.question}
              </span>
            </label>
          ))}
          {!!selected.length && (
            <>
              <label className="block space-y-1 text-small">
                {tr('未共享来源的处理')}
                <Select
                  aria-label={tr('未共享来源的处理')}
                  value={policy}
                  disabled={disabled || busy}
                  onChange={(e) => {
                    setPolicy(e.target.value as 'mark' | 'remove');
                    invalidate();
                  }}
                >
                  <option value="mark">{tr('保留引用文字，标明“来源未共享”')}</option>
                  <option value="remove">{tr('移除无法共享的引用标记')}</option>
                </Select>
              </label>
              <p className="text-caption text-fg-muted">
                {tr(
                  '也可以先单独发布被引用的论文，再核对团队资料。这里不会替你发布其他个人论文。正文中的敏感内容需自行检查。',
                )}
              </p>
              <Button
                variant="secondary"
                loading={busy}
                disabled={disabled || !projectId}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  invalidate();
                  try {
                    const fresh = await Promise.all(
                      selected.map((id) => qaApi.flush(scope, paperId, id)),
                    );
                    const result = await qaApi.preview(
                      scope,
                      paperId,
                      projectId,
                      fresh.map((t) => ({
                        id: t.id,
                        version: t.version,
                        unsharedSources: policy,
                        allowMissingContext: false,
                      })),
                      targetPaperId,
                    );
                    setPreview(result);
                    if (!result.turns.some((t) => t.missingContext.length))
                      onChange(selections(result, false));
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {tr('预览所选问答')}
              </Button>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-3 rounded-md border border-line p-3 text-small">
          <p className="font-medium">{tr('以下问答全文和来源将对项目成员可见。')}</p>
          {preview.turns.map((t) => (
            <article key={t.id} className="space-y-2 border-b border-line pb-3">
              <p>
                {tr('提出者：{name} · v{version}', {
                  name: trServer(t.author.name),
                  version: t.version,
                })}
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere font-sans">
                {t.question}
                {'\n\n'}
                {t.answer}
              </pre>
              {t.selection && (
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {tr('用户选句 · 第 ')}
                  {t.selection.page}
                  {tr(' 页 ·')}{' '}
                  {t.selection.status === 'available'
                    ? tr('指向团队 PDF')
                    : tr('原文来源未共享／版本不同')}
                  {tr('：')}
                  {t.selection.text}
                </p>
              )}
              {t.sources.map((s) => (
                <p key={s.id} className="text-caption wrap-anywhere">
                  {s.paperTitle} · p.{s.page} ¶{s.para} ·{' '}
                  {s.status === 'unshared' ? tr('来源未共享') : tr('指向团队 PDF 副本')}
                  {s.quote ? tr('：{quote}', { quote: s.quote }) : ''}
                </p>
              ))}
              {t.privateLinksRemoved && (
                <p className="text-warning">{tr('已清理已知的个人资源链接。')}</p>
              )}
              {t.unsharedSources.length > 0 && (
                <p className="text-warning">
                  {tr('存在 {count} 处未共享或待核实的引用。', { count: t.unsharedSources.length })}
                </p>
              )}
              {t.missingContext.length > 0 && (
                <div className="text-warning">
                  <p>{tr('回答依赖以下未选中或版本不同的历史问答：')}</p>
                  {t.missingContext.map((c) => (
                    <p key={c.id} className="wrap-anywhere">
                      v{c.version} · {c.question}
                    </p>
                  ))}
                  <p>{tr('可以返回补选，或先在问答栏目“制作说明稿”后整理成独立结论。')}</p>
                </div>
              )}
            </article>
          ))}
          {hasMissing && (
            <label className="flex min-h-11 items-start gap-2">
              <input
                type="checkbox"
                checked={ack}
                disabled={disabled}
                onChange={(e) => {
                  setAck(e.target.checked);
                  onChange(e.target.checked ? selections(preview, true) : null);
                }}
              />
              {tr('我已核对正文，确认按“上下文不完整”发布这些问答。')}
            </label>
          )}
        </div>
      )}
    </section>
  );
}
