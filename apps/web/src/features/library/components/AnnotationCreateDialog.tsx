import { useState } from 'react';
import type { AnnotationColor, PaperAnnotation } from '@srh/shared';
import { Button, Dialog, Input, Select, Textarea } from '@/components/ui';
import type { LibraryScope } from '../lib/scope';
import { isPersonalLibrary } from '../lib/scope';
import { ANNOTATION_COLORS } from '../lib/annotations';
import { annotationApi } from '../annotations-api';
import type { PdfTextSelection } from '../pdf/selection';
import { tr } from '@/lib/i18n';

export interface AnnotationDraft {
  kind: 'highlight' | 'comment';
  fileId: string;
  selection: PdfTextSelection;
}
export function AnnotationCreateDialog({
  scope,
  paperId,
  draft,
  onClose,
  onCreated,
}: {
  scope: LibraryScope;
  paperId: string;
  draft: AnnotationDraft;
  onClose: () => void;
  onCreated: (annotation: PaperAnnotation) => void;
}) {
  const [color, setColor] = useState<AnnotationColor>('yellow');
  const [label, setLabel] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      open
      size="md"
      title={draft.kind === 'highlight' ? tr('保存高亮') : tr('添加批注')}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      description={
        isPersonalLibrary(scope)
          ? tr('仅保存到个人文献库，发布时再逐条选择。')
          : tr('保存到项目文献库，所有项目成员都能查看和共同维护。')
      }
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const row = await annotationApi.create(scope, paperId, {
                  kind: draft.kind,
                  color,
                  label,
                  body,
                  fileId: draft.fileId,
                  page: draft.selection.page,
                  quote: draft.selection.text,
                  boxes: draft.selection.boxes.map((b) => ({
                    ...b,
                    x: Math.max(0, b.x),
                    y: Math.max(0, b.y),
                  })),
                });
                onCreated(row);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr('保存标注')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-caption text-fg-muted">
          {tr('原文 · 第 {page} 页', { page: draft.selection.page })}
        </p>
        <blockquote className="max-h-40 overflow-auto rounded-md bg-subtle p-3 text-small whitespace-pre-wrap wrap-anywhere">
          {draft.selection.text}
        </blockquote>
        {draft.selection.warning && (
          <p className="text-small text-warning">{draft.selection.warning}</p>
        )}
        <label className="block space-y-1 text-small">
          <span>{tr('标注颜色')}</span>
          <Select
            aria-label={tr('标注颜色')}
            value={color}
            onChange={(e) => setColor(e.target.value as AnnotationColor)}
          >
            {Object.entries(ANNOTATION_COLORS).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block space-y-1 text-small">
          <span>{tr('简短说明（可选）')}</span>
          <Input
            aria-label={tr('标注说明')}
            maxLength={160}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={tr('例如：实验条件、需要复核')}
          />
        </label>
        {draft.kind === 'comment' && (
          <label className="block space-y-1 text-small">
            <span>{tr('批注正文')}</span>
            <Textarea
              aria-label={tr('新批注正文')}
              rows={5}
              maxLength={100000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={tr('写下对这段原文的理解或疑问…')}
            />
          </label>
        )}
        <p className="text-caption text-fg-muted">
          {tr('高亮与批注各自保存；添加批注不会自动创建或发布另一条高亮。')}
        </p>
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
