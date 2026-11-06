import { useState } from 'react';
import { Link } from 'react-router';
import { FileCode2 } from 'lucide-react';
import type { LibraryCiteToDocResult } from '@srh/shared';
import { Button, Dialog, EmptyState, Input, Select, toast } from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { useCiteToDoc, useLatexDocs } from '../api';
import { tr } from '@/lib/i18n';

/**
 * 插入引用：把选中论文的 BibTeX 合并进某个 LaTeX 文档的 .bib，得到 \cite{…}（复制后贴到正文）。
 */
export function CiteToDocDialog({
  pid,
  paperIds,
  open,
  onOpenChange,
}: {
  pid: string;
  paperIds: string[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const docs = useLatexDocs(pid, open);
  const cite = useCiteToDoc(pid);
  const [picked, setDocId] = useState('');
  const [bibFile, setBibFile] = useState('references.bib');
  const [result, setResult] = useState<LibraryCiteToDocResult | null>(null);
  // 没选时默认第一个 LaTeX 文档
  const docId = picked || docs.data?.[0]?.id || '';

  /** 关闭时清掉上一次的结果，下次打开从头开始 */
  const setOpen = (v: boolean) => {
    if (!v) {
      setResult(null);
      cite.reset();
    }
    onOpenChange(v);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: 'success', title: tr('已复制'), description: text });
    } catch {
      toast({ tone: 'warning', title: tr('复制失败，请手动选中复制') });
    }
  };

  const submit = () =>
    cite.mutate(
      { docId, paperIds, bibFile: bibFile.trim() || 'references.bib' },
      {
        onSuccess: (r) => {
          setResult(r);
          void copy(r.cite);
        },
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={tr('插入引用到 LaTeX 文档')}
      description={tr(
        '把 {count} 篇论文的 BibTeX 写进文档工程的 .bib（已有的条目不重复写），并复制 \\cite 命令。',
        { count: paperIds.length },
      )}
      size="sm"
      footer={
        result ? (
          <Button variant="primary" onClick={() => setOpen(false)}>
            {tr('完成')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tr('取消')}
            </Button>
            <Button variant="primary" loading={cite.isPending} disabled={!docId} onClick={submit}>
              {tr('写入引用')}
            </Button>
          </>
        )
      }
    >
      {docs.isPending ? (
        <p className="text-small text-fg-muted">{tr('正在加载文档…')}</p>
      ) : (docs.data ?? []).length === 0 ? (
        <EmptyState
          icon={FileCode2}
          title={tr('项目里还没有 LaTeX 文档')}
          description={tr('先在“文档”里新建一个 LaTeX 文档，再回来插入引用。')}
          action={
            <Link
              to={projectPath(pid, 'docs')}
              className="text-small text-accent-text hover:underline"
            >
              {tr('去文档')}
            </Link>
          }
        />
      ) : result ? (
        <div className="flex flex-col gap-3">
          <p className="text-small text-fg">
            {tr('已写入 ')}
            <code className="font-mono">{result.bibFile}</code>
            {result.added > 0
              ? tr('（新增 {added} 条）', { added: result.added })
              : tr('（条目都已存在）')}
            {tr('。把下面的命令贴到正文里：')}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-subtle px-2 py-1.5 font-mono text-small">
              {result.cite}
            </code>
            <Button size="sm" variant="secondary" onClick={() => void copy(result.cite)}>
              {tr('复制')}
            </Button>
          </div>
          <p className="text-caption text-fg-muted">
            {tr('正文里还需要')}{' '}
            <code className="font-mono">{`\\bibliography{${result.bibFile.replace(/\.bib$/u, '')}}`}</code>
            {tr('（或 biblatex 的 \\addbibresource）。')}
          </p>
          <Link
            to={projectPath(pid, `docs/${result.docId}`)}
            className="text-small text-accent-text hover:underline"
          >
            {tr('打开文档')}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Select
            aria-label={tr('LaTeX 文档')}
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
          >
            {(docs.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </Select>
          <Input
            aria-label={tr('.bib 文件')}
            value={bibFile}
            onChange={(e) => setBibFile(e.target.value)}
            placeholder="references.bib"
          />
          {cite.error && <p className="text-small text-danger">{cite.error.message}</p>}
        </div>
      )}
    </Dialog>
  );
}
