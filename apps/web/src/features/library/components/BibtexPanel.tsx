import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, FileCode2 } from 'lucide-react';
import { Button, Skeleton, toast } from '@/components/ui';
import { downloadText, fetchBibtex } from '../api';
import { useReader } from '../lib/reader';
import { isPersonalLibrary, libraryKey } from '../lib/scope';
import { CiteToDocDialog } from './CiteToDocDialog';
import { tr } from '@/lib/i18n';

/** 单篇 BibTeX：复制、下载、写进 LaTeX 文档 */
export function BibtexPanel() {
  const { paper, writable, scope: pid } = useReader();
  const [citeOpen, setCiteOpen] = useState(false);
  const q = useQuery({
    queryKey: [...libraryKey(pid), 'bibtex', paper.id, paper.updatedAt],
    queryFn: () => fetchBibtex(pid, [paper.id]),
  });
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: 'success', title: tr('已复制{what}', { what }) });
    } catch {
      toast({ tone: 'warning', title: tr('复制失败，请手动选中复制') });
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      <p className="text-small text-fg-muted">
        {tr(
          '这里是论文的参考文献条目，包含作者、标题、年份等信息。复制或下载 .bib 可用于 LaTeX 写作，也可导入 Zotero 等文献管理工具；引用前请核对信息是否完整。',
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-small text-fg-muted">{tr('引用键')}</span>
        <code className="rounded-sm bg-subtle px-1.5 py-0.5 font-mono text-small">
          {paper.citekey}
        </code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copy(`\\cite{${paper.citekey}}`, ' \\cite')}
        >
          {tr('复制 \\cite')}
        </Button>
      </div>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <p className="text-small text-danger">{q.error.message}</p>
      ) : (
        <pre className="overflow-x-auto rounded-md border border-line bg-subtle px-3 py-2.5 font-mono text-caption leading-relaxed whitespace-pre text-fg">
          {q.data}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!q.data}
          leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
          onClick={() => q.data && void copy(q.data, ' BibTeX')}
        >
          {tr('复制条目')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!q.data}
          leftIcon={<Download strokeWidth={1.75} aria-hidden />}
          onClick={() => q.data && downloadText(`${paper.citekey}.bib`, q.data)}
        >
          {tr('下载 .bib')}
        </Button>
        {writable && !isPersonalLibrary(pid) && (
          <Button
            size="sm"
            variant="primary"
            leftIcon={<FileCode2 strokeWidth={1.75} aria-hidden />}
            onClick={() => setCiteOpen(true)}
          >
            {tr('插入引用')}
          </Button>
        )}
      </div>
      <p className="text-caption text-fg-muted">
        {tr('引用键在元数据确定后固定不变；同名冲突时自动加 b、c 后缀。')}
      </p>
      {!isPersonalLibrary(pid) && (
        <CiteToDocDialog
          pid={pid}
          paperIds={[paper.id]}
          open={citeOpen}
          onOpenChange={setCiteOpen}
        />
      )}
    </div>
  );
}
