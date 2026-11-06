import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { Editor } from '@tiptap/core';
import type * as Y from 'yjs';
import { toast } from '@/components/ui';
import type { Slot } from '../../ext/slot';
import {
  pageGeometry,
  readPageViewPref,
  usePageSetup,
  writePageSetup,
  writePageViewPref,
  type PageSetup,
} from '../../word/page';
import { PAGE_GAP } from '../../word/pagination';
import { downloadHtml, downloadWord, printDocument } from '../../word/export';
import { pickFiles } from '../../media/upload-plugin';
import { fetchDocMarkdown } from '../../../../detail/api';
import { downloadText, safeFileName, useElementSize } from '../../../shared/dom';
import type { ExportKind, WordControls } from '../Toolbar';
import { PageSetupDialog } from './PageSetupDialog';
import { ImportWordDialog } from './ImportWordDialog';
import { tr } from '@/lib/i18n';

const DOCX_ACCEPT = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Word 式功能的状态：页面设置（协同共享）、页面视图（个人偏好；窗口比纸窄时自动退回连续视图，避免横向滚动）、
 * 查找替换面板、导入 Word、导出。
 */
export function useWordFeatures({
  editor,
  findSlot,
  ydoc,
  projectId,
  docId,
  title,
}: {
  editor: Editor;
  findSlot: Slot<(replace: boolean) => boolean>;
  ydoc: Y.Doc;
  projectId: string;
  docId: string;
  title: string;
}) {
  const page = usePageSetup(ydoc);
  const [pref, setPref] = useState(readPageViewPref);
  const [measure, size] = useElementSize<HTMLDivElement>();
  const geometry = useMemo(() => pageGeometry(page), [page]);
  // 纸张 + 两侧各 16px 放得下才分页显示
  const fits = size.width === 0 || size.width >= geometry.width + 32;
  const paged = pref && fits;
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [find, setFind] = useState<{ replace: boolean; nonce: number } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);

  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.commands.setPageGeometry(paged ? geometry : null);
  }, [editor, paged, geometry]);

  // 页数：分页插件测量后更新（不在页面视图时不显示）
  useEffect(() => {
    if (!paged) return;
    const read = () => {
      if (editor.isDestroyed) return;
      const n = editor.storage.pagination.pageCount;
      setPageCount((prev) => (prev === n ? prev : n || null));
    };
    read();
    editor.on('transaction', read);
    return () => {
      editor.off('transaction', read);
    };
  }, [editor, paged]);

  const openFind = useCallback((replace: boolean) => {
    setFind((f) => ({ replace: replace || (f?.replace ?? false), nonce: (f?.nonce ?? 0) + 1 }));
    return true;
  }, []);
  useEffect(() => {
    findSlot.set(openFind);
    return () => findSlot.set(null);
  }, [findSlot, openFind]);

  const setPageView = useCallback(
    (on: boolean) => {
      writePageViewPref(on);
      setPref(on);
      if (on && !fits) toast({ title: tr('窗口比纸张窄，先用连续视图显示'), tone: 'info' });
    },
    [fits],
  );

  const exportAs = useCallback(
    (kind: ExportKind) => {
      const name = title || tr('未命名文档');
      if (kind === 'docx') {
        void downloadWord(editor, name, page)
          .then(() => toast({ title: tr('已导出 Word 文档'), tone: 'success' }))
          .catch(() => toast({ title: tr('导出失败，请稍后再试'), tone: 'danger' }));
      } else if (kind === 'pdf') {
        if (!printDocument(editor, name, page)) {
          toast({
            title: tr('浏览器拦截了打印窗口'),
            description: tr('允许本站弹出窗口后再试一次'),
            tone: 'danger',
          });
        }
      } else if (kind === 'html') {
        downloadHtml(editor, name, page);
      } else {
        void fetchDocMarkdown(projectId, docId)
          .then((c) => downloadText(`${safeFileName(name)}.md`, c.markdown, 'text/markdown'))
          .catch(() => toast({ title: tr('导出失败，请稍后再试'), tone: 'danger' }));
      }
    },
    [editor, page, title, projectId, docId],
  );

  const controls: WordControls = {
    page,
    setPage: (patch) => writePageSetup(ydoc, patch),
    pageView: pref,
    setPageView,
    openPageSetup: () => setSetupOpen(true),
    openFind: (replace) => void openFind(replace),
    importWord: () => {
      void pickFiles(DOCX_ACCEPT, false).then((files) => {
        const f = files[0];
        if (!f) return;
        if (!/\.docx$/iu.test(f.name)) {
          toast({
            title: tr('只支持 .docx 格式的 Word 文档'),
            description: tr('旧版 .doc 请先在 Word 里另存为 .docx'),
            tone: 'danger',
          });
          return;
        }
        setImportFile(f);
      });
    },
    exportAs,
  };

  const pagedStyle: CSSProperties | undefined = paged
    ? ({
        '--page-w': `${geometry.width}px`,
        '--page-h': `${geometry.height}px`,
        '--page-mt': `${geometry.top}px`,
        '--page-mr': `${geometry.right}px`,
        '--page-mb': `${geometry.bottom}px`,
        '--page-ml': `${geometry.left}px`,
        '--page-gap': `${PAGE_GAP}px`,
      } as CSSProperties)
    : undefined;

  const dialogs: ReactNode = (
    <>
      <PageSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        value={page}
        onSave={(next: PageSetup) => {
          writePageSetup(ydoc, next);
          setSetupOpen(false);
        }}
      />
      {editor.isEditable && (
        <ImportWordDialog
          editor={editor}
          ydoc={ydoc}
          projectId={projectId}
          file={importFile}
          onClose={() => setImportFile(null)}
        />
      )}
    </>
  );

  return {
    controls,
    paged,
    pagedStyle,
    measure,
    pageCount: paged ? pageCount : null,
    find,
    closeFind: () => setFind(null),
    dialogs,
  };
}
