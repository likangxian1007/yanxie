import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { FileUp } from 'lucide-react';
import type * as Y from 'yjs';
import type { DocumentMeta } from '@srh/shared';
import { Button, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { isBlankDoc } from './blank';
import { ImportDialog } from './ImportDialog';
import { IMPORT_FORMATS } from './registry';
import { useImportQueue, type ImportItem } from './useImportQueue';
import { tr } from '@/lib/i18n';

const FORMAT_LABEL: Record<DocumentMeta['kind'], string> = {
  doc: tr('Word、Markdown、纯文本或网页'),
  sheet: tr('Excel 或 CSV'),
  slides: 'PowerPoint',
  latex: tr('.tex 文件或 LaTeX 工程 .zip'),
};

/** 空白文档的实时判断（内容一变就重新算，150ms 防抖） */
function useIsBlank(meta: DocumentMeta, doc: Y.Doc): boolean {
  const [blank, setBlank] = useState(() => isBlankDoc(meta.kind, doc, meta.title));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setBlank(isBlankDoc(meta.kind, doc, meta.title)), 150);
    };
    check();
    doc.on('update', check);
    return () => {
      if (timer) clearTimeout(timer);
      doc.off('update', check);
    };
  }, [doc, meta.kind, meta.title]);
  return blank;
}

/**
 * 文档页的空白状态入口：这份文档还是空的时候，提示“从文件导入”。
 * 导入会新建一份同类型文档（同一父文档下），成功后删掉这份空白文档并跳过去；
 * 如果导入期间有人往空白文档里写了内容，就保留它。
 */
export function BlankDocImport({
  pid,
  meta,
  doc,
}: {
  pid: string;
  meta: DocumentMeta;
  doc: Y.Doc;
}) {
  const navigate = useNavigate();
  const blank = useIsBlank(meta, doc);
  const [open, setOpen] = useState(false);
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  });

  const onDone = (item: ImportItem & { meta: DocumentMeta }) => {
    setOpen(false);
    const stillBlank = isBlankDoc(meta.kind, docRef.current, meta.title);
    const go = () => navigate(`/p/${pid}/docs/${item.meta.id}`, { replace: true });
    if (item.warnings.length) {
      toast({
        title: tr('已导入，有部分内容没能导入'),
        description: item.warnings.join(tr('；')),
        tone: 'warning',
      });
    }
    if (!stillBlank) {
      toast({
        title: tr('已导入为新文档'),
        description: tr('原来的文档里有人写了内容，已保留。'),
        tone: 'info',
      });
      go();
      return;
    }
    // 先离开再删，避免当前页面去读一份已删除的文档
    go();
    void api.delete(`/projects/${pid}/docs/${meta.id}`).catch(() => undefined);
  };
  const queue = useImportQueue(
    `blank:${meta.id}`,
    { pid, parentId: meta.parentId, onlyKind: meta.kind },
    onDone,
  );

  const supported = IMPORT_FORMATS.some((f) => f.kind === meta.kind);
  if (!supported || (!blank && !open && !queue.busy)) return null;

  return (
    <>
      <div className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-line-strong bg-surface px-3 py-2 md:mx-6">
        <FileUp size={16} strokeWidth={1.75} className="shrink-0 text-fg-subtle" aria-hidden />
        <p className="min-w-0 flex-1 text-small text-fg-muted">
          {tr('这份文档还是空的，可以直接导入已有的文件：{value}。', {
            value: FORMAT_LABEL[meta.kind],
          })}
        </p>
        <Button size="sm" variant="secondary" loading={queue.busy} onClick={() => setOpen(true)}>
          {tr('从文件导入')}
        </Button>
      </div>
      <ImportDialog
        open={open}
        onOpenChange={setOpen}
        queue={queue}
        hrefOf={(id) => `/p/${pid}/docs/${id}`}
        onlyKind={meta.kind}
        single
        title={tr('从文件导入')}
        description={tr('支持{value}{value2}，导入后替换这份空白文档。', {
          value: /^[A-Za-z.]/u.test(FORMAT_LABEL[meta.kind]) ? ' ' : '',
          value2: FORMAT_LABEL[meta.kind],
        })}
      />
    </>
  );
}
