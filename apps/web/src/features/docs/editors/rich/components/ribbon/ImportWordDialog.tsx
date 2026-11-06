import { useState } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import { FileText } from 'lucide-react';
import type * as Y from 'yjs';
import { Button, Dialog, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { fileUrl, uploadFile } from '../../media/upload';
import { writePageSetup } from '../../word/page';
import { ICON_STROKE } from '../icons';
import { tr } from '@/lib/i18n';

type Mode = 'insert' | 'replace';

/**
 * 编辑器里的“导入 Word”：选好 .docx 后确认是插入到光标处还是替换全文。
 * 替换全文时连同纸张和页边距一起换成 Word 文档的；整个导入是一次编辑，Ctrl+Z 可以撤销。
 */
export function ImportWordDialog({
  editor,
  ydoc,
  projectId,
  file,
  onClose,
}: {
  editor: Editor;
  ydoc: Y.Doc;
  projectId: string;
  file: File | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('insert');
  const [busy, setBusy] = useState(false);
  const empty = editor.state.doc.textContent.trim() === '' && editor.state.doc.childCount <= 1;
  const effective: Mode = empty ? 'replace' : mode;

  const run = async () => {
    if (!file) return;
    setBusy(true);
    const at = editor.state.selection.from;
    try {
      // 解析库（docx-preview）用到时才加载
      const [{ docxToPm }, { sanitizeDoc }] = await Promise.all([
        import('../../word/docx-import'),
        import('../../../../import/docx'),
      ]);
      const result = await docxToPm(
        file,
        {
          projectId,
          uploadFile: async (blob, name) => {
            const f = await uploadFile(projectId, new File([blob], name, { type: blob.type }))
              .promise;
            return { id: f.id, url: fileUrl(projectId, f.id) };
          },
        },
        file.name,
      );
      if (editor.isDestroyed) return;
      const { doc, degraded } = sanitizeDoc(result.doc);
      const content = (doc.content ?? []) as JSONContent[];
      if (effective === 'replace') {
        editor
          .chain()
          .focus()
          .setContent(doc as JSONContent)
          .run();
        writePageSetup(ydoc, result.page);
      } else {
        editor
          .chain()
          .focus()
          .insertContentAt(Math.min(at, editor.state.doc.content.size), content)
          .run();
      }
      const warnings = [
        ...result.warnings,
        ...(degraded ? [tr('有 {degraded} 处复杂排版只保留了文字', { degraded })] : []),
      ];
      toast({
        title: tr('已导入“{name}”', { name: file.name }),
        ...(warnings.length ? { description: warnings.join(tr('；')) } : {}),
        tone: warnings.length ? 'info' : 'success',
      });
      onClose();
    } catch (e) {
      toast({
        title: tr('导入失败'),
        description: e instanceof Error ? e.message : tr('Word 文档解析失败'),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={file !== null}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={tr('导入 Word 文档')}
      description={file ? file.name : undefined}
      size="sm"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button
            variant={effective === 'replace' && !empty ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => void run()}
          >
            {effective === 'replace' ? (empty ? tr('导入') : tr('替换全文')) : tr('插入')}
          </Button>
        </>
      }
    >
      {empty ? (
        <p className="text-body text-fg-muted">
          {tr('会把 Word 里的标题、文字格式、列表、表格、图片、脚注和页面设置导入到这篇文档。')}
        </p>
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={tr('导入方式')}>
          {(
            [
              ['insert', tr('插入到光标处'), tr('保留现有内容，Word 的内容放在光标所在位置')],
              [
                'replace',
                tr('替换全文'),
                tr('现有内容会被 Word 的内容替换（可以撤销），纸张和页边距也换成 Word 的'),
              ],
            ] as [Mode, string, string][]
          ).map(([m, title, desc]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'flex items-start gap-3 rounded-md border p-3 text-left transition-colors duration-(--dur-fast)',
                mode === m ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle',
              )}
            >
              <FileText
                size={16}
                strokeWidth={ICON_STROKE}
                aria-hidden
                className={cn(
                  'mt-0.5 shrink-0',
                  mode === m ? 'text-accent-text' : 'text-fg-subtle',
                )}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-body font-medium text-fg">{title}</span>
                <span className="text-small text-fg-muted">{desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
