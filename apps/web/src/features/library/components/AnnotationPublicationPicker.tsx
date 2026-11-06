import { useState } from 'react';
import type { PaperAnnotation } from '@srh/shared';
import { Button } from '@/components/ui';
import { annotationApi, usePaperAnnotations } from '../annotations-api';
import type { PersonalLibrary } from '../lib/scope';
import { ANNOTATION_COLORS, annotationLabel } from '../lib/annotations';
import { tr } from '@/lib/i18n';

export function AnnotationPublicationPicker({
  scope,
  paperId,
  disabled,
  onChange,
}: {
  scope: PersonalLibrary;
  paperId: string;
  disabled: boolean;
  onChange: (selection: { id: string; version: number }[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const query = usePaperAnnotations(scope, paperId, open);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<PaperAnnotation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = query.data?.filter((a) => !a.deletedAt) ?? [];
  if (!open)
    return (
      <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>
        {tr('选择要发布的高亮和批注')}
      </Button>
    );
  return (
    <section className="space-y-3">
      <p className="text-small font-medium">{tr('逐条选择高亮和批注（默认全不选）')}</p>
      <p className="text-caption text-fg-muted">
        {tr('只选高亮不会携带其他批注；只选批注会携带它的原文位置，不复制其他阅读记录。')}
      </p>
      {query.isPending && <p role="status">{tr('正在读取标注…')}</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>{tr('重试')}</Button>
        </p>
      )}
      {!query.isPending && !query.error && !rows.length && (
        <p className="text-small text-fg-muted">{tr('暂无高亮或批注，可先在阅读页创建。')}</p>
      )}
      {(['highlight', 'comment'] as const).map((kind) => (
        <div key={kind} className="space-y-1">
          <p className="text-small text-fg-muted">
            {kind === 'highlight' ? tr('高亮') : tr('批注')}
          </p>
          {rows
            .filter((a) => a.kind === kind)
            .map((a) => (
              <label key={a.id} className="flex min-h-11 items-start gap-2 py-1 text-small">
                <input
                  className="mt-1"
                  type="checkbox"
                  disabled={disabled || busy || a.anchorStatus !== 'current'}
                  checked={selected.includes(a.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, a.id]
                      : selected.filter((id) => id !== a.id);
                    setSelected(next);
                    setPreview(null);
                    setError('');
                    onChange(next.length ? null : []);
                  }}
                />
                <span className="min-w-0 wrap-anywhere">
                  {annotationLabel(a)}
                  <span className="mt-1 block line-clamp-2 text-fg-muted">{a.quote}</span>
                  {a.anchorStatus !== 'current' && (
                    <span className="block text-warning">
                      {tr('原文版本不同，定位待确认，暂不能发布。')}
                    </span>
                  )}
                </span>
              </label>
            ))}
        </div>
      ))}
      {selected.length > 0 && (
        <Button
          variant="secondary"
          loading={busy}
          disabled={disabled}
          onClick={async () => {
            setBusy(true);
            setError('');
            setPreview(null);
            onChange(null);
            try {
              const records = await Promise.all(
                selected.map((id) => annotationApi.flush(scope, paperId, id)),
              );
              if (records.some((a) => a.anchorStatus !== 'current'))
                throw new Error(tr('所选标注的 PDF 版本已变化，请重新核对定位。'));
              setPreview(records);
              onChange(records.map((a) => ({ id: a.id, version: a.version })));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {preview ? tr('重新预览所选标注') : tr('预览所选标注')}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <p className="text-small font-medium">
            {tr('以下原文、颜色、说明和批注正文将进入项目副本。')}
          </p>
          {preview.map((a) => (
            <article key={a.id} className="space-y-2 text-small">
              <p className="font-medium wrap-anywhere">
                {annotationLabel(a)} · {ANNOTATION_COLORS[a.color]}
              </p>
              <blockquote className="max-h-48 overflow-auto bg-subtle p-2 whitespace-pre-wrap wrap-anywhere">
                {a.quote}
              </blockquote>
              {a.kind === 'comment' && (
                <pre className="max-h-64 overflow-auto font-sans whitespace-pre-wrap wrap-anywhere">
                  {a.body || tr('（空白批注）')}
                </pre>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
