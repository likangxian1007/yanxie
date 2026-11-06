import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpenText,
  Download,
  ExternalLink,
  ListTree,
  Sigma,
  Table2,
  Image as ImageIcon,
} from 'lucide-react';
import type { PaperChunk, PaperFigure, PaperFormula, PaperReference } from '@srh/shared';
import { Badge, Button, EmptyState, Tabs, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { Link } from 'react-router';
import { usePersonalLibrary } from '../lib/use-library-scope';
import { libraryPath } from '../lib/scope';
import { useImportPaper } from '../api';
import { useReader } from '../lib/reader';
import { PdfCrop } from '../pdf/PdfCrop';
import { TexMath } from './TexMath';
import { tr } from '@/lib/i18n';

type View = 'outline' | 'text' | 'formulas' | 'figures' | 'refs';

/**
 * 结构面板：目录、正文（段落 + 公式）、公式、图表（裁图 + 表格）、参考文献（可按 DOI / arXiv 导入）。
 * 每一项都能点回 PDF 原文位置。
 */
export function StructurePanel() {
  const { paper } = useReader();
  const s = paper.structure;
  const [view, setView] = useState<View>('outline');
  if (!s) {
    return (
      <EmptyState
        icon={ListTree}
        title={tr('还没有结构')}
        description={tr('论文解析完成后，这里会显示目录、段落、公式、图表和参考文献。')}
      />
    );
  }
  const counts = {
    outline: s.sections.length,
    text: s.chunks.length,
    formulas: s.formulas.length,
    figures: s.figures.length,
    refs: s.references.length,
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 overflow-x-auto border-b border-line px-3 py-2">
        <Tabs
          variant="segmented"
          size="sm"
          aria-label={tr('结构视图')}
          layoutId="lib-structure"
          value={view}
          onValueChange={setView}
          items={[
            { value: 'outline', label: tr('目录'), count: counts.outline },
            { value: 'text', label: tr('正文'), count: counts.text },
            { value: 'formulas', label: tr('公式'), count: counts.formulas },
            { value: 'figures', label: tr('图表'), count: counts.figures },
            { value: 'refs', label: tr('文献'), count: counts.refs },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {view === 'outline' && <Outline />}
        {view === 'text' && <FullText />}
        {view === 'formulas' && <Formulas />}
        {view === 'figures' && <Figures />}
        {view === 'refs' && <References />}
      </div>
    </div>
  );
}

function Outline() {
  const { paper, jump } = useReader();
  const s = paper.structure!;
  if (s.sections.length === 0) {
    return (
      <EmptyState
        icon={ListTree}
        title={tr('没有识别出章节')}
        description={
          paper.parser === 'pdf-text'
            ? tr('这篇是纯文本降级解析，没有章节结构。解析服务恢复后可以重新解析。')
            : tr('这篇论文没有带编号的章节标题，可以在“正文”里按段落阅读。')
        }
      />
    );
  }
  return (
    <div>
      {paper.abstract && (
        <section className="mb-4 rounded-md border border-line bg-subtle px-3 py-2.5">
          <h3 className="mb-1 text-caption font-semibold text-fg-muted">{tr('摘要')}</h3>
          <p className="text-small leading-relaxed text-fg">{paper.abstract}</p>
        </section>
      )}
      <ol className="flex flex-col" aria-label={tr('目录')}>
        {s.sections.map((sec, i) => (
          <li key={i}>
            <button
              type="button"
              className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-small hover:bg-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              style={{ paddingLeft: 8 + (sec.level - 1) * 14 }}
              onClick={() => sec.page && jump(sec.page, sec.boxes)}
            >
              {sec.n && <span className="shrink-0 text-fg-subtle tabular-nums">{sec.n}</span>}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  sec.level === 1 ? 'font-medium text-fg' : 'text-fg-muted',
                )}
              >
                {sec.title}
              </span>
              {sec.page && (
                <span className="shrink-0 text-caption text-fg-subtle tabular-nums">
                  p.{sec.page}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FullText() {
  const { paper, jump, activeSeq } = useReader();
  const s = paper.structure!;
  const formulas = useMemo(
    () => new Map(s.formulas.filter((f) => f.chunkSeq !== null).map((f) => [f.chunkSeq!, f])),
    [s.formulas],
  );
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (activeSeq === null) return;
    listRef.current
      ?.querySelector(`[data-seq="${activeSeq}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeSeq]);
  return (
    <ol ref={listRef} className="flex flex-col gap-1" aria-label={tr('正文段落')}>
      {s.chunks.map((c, i) => {
        // 小节变了才显示小节路径
        const head =
          i === 0 || s.chunks[i - 1]!.sectionPath !== c.sectionPath ? c.sectionPath : null;
        return (
          <li key={c.seq} data-seq={c.seq}>
            {head && (
              <h3 className="mt-3 mb-1 px-2 text-caption font-semibold text-fg-muted first:mt-0">
                {head}
              </h3>
            )}
            <ChunkBlock
              chunk={c}
              formula={formulas.get(c.seq)}
              active={activeSeq === c.seq}
              onJump={() => jump(c.page, c.boxes)}
            />
          </li>
        );
      })}
    </ol>
  );
}

function ChunkBlock({
  chunk,
  formula,
  active,
  onJump,
}: {
  chunk: PaperChunk;
  formula: PaperFormula | undefined;
  active: boolean;
  onJump: () => void;
}) {
  const { paper } = useReader();
  return (
    <div className={cn('group relative rounded-sm px-2 py-1.5', active && 'lib-para-active')}>
      <button
        type="button"
        onClick={onJump}
        className="absolute top-1.5 right-1 rounded-xs px-1 text-caption text-fg-subtle tabular-nums hover:bg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        title={tr('跳到原文')}
      >
        p.{chunk.page} ¶{chunk.para}
      </button>
      {formula ? (
        <FormulaView formula={formula} macros={paper.structure!.macros} />
      ) : (
        <p
          className={cn(
            'pr-14 text-small leading-relaxed',
            chunk.kind === 'note' || chunk.kind === 'caption' ? 'text-fg-muted' : 'text-fg',
            chunk.kind === 'abstract' && 'italic',
          )}
        >
          {chunk.text}
        </p>
      )}
    </div>
  );
}

function FormulaView({
  formula,
  macros,
}: {
  formula: PaperFormula;
  macros: Record<string, string>;
}) {
  const { doc } = useReader();
  const box = formula.boxes[0];
  return (
    <div className="flex items-center gap-2 pr-14">
      <div className="min-w-0 flex-1">
        {formula.latex ? (
          <TexMath tex={formula.latex} display macros={macros} />
        ) : box ? (
          <PdfCrop
            doc={doc}
            box={unionBox(formula.boxes)}
            maxWidth={380}
            label={tr('公式 {value}：{text}', { value: formula.label ?? '', text: formula.text })}
          />
        ) : (
          <code className="font-mono text-small">{formula.text}</code>
        )}
      </div>
      {formula.label && (
        <span className="shrink-0 text-small text-fg-muted tabular-nums">{formula.label}</span>
      )}
    </div>
  );
}

/** 同一页上的多个框合成一个（公式常被拆成好几行） */
function unionBox(boxes: { page: number; x: number; y: number; w: number; h: number }[]) {
  const first = boxes[0]!;
  const same = boxes.filter((b) => b.page === first.page);
  const x0 = Math.min(...same.map((b) => b.x));
  const y0 = Math.min(...same.map((b) => b.y));
  const x1 = Math.max(...same.map((b) => b.x + b.w));
  const y1 = Math.max(...same.map((b) => b.y + b.h));
  return { page: first.page, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function Formulas() {
  const { paper, jump } = useReader();
  const s = paper.structure!;
  if (s.formulas.length === 0) {
    return (
      <EmptyState
        icon={Sigma}
        title={tr('没有识别出公式')}
        description={tr('GROBID 没有在这篇论文里找到行间公式。')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {!paper.hasLatexSource && (
        <p className="rounded-md bg-subtle px-3 py-2 text-caption text-fg-muted">
          {tr('没有 LaTeX 源码（不是 arXiv 论文或源码不可用），公式显示的是 PDF 原图区域。')}
        </p>
      )}
      {s.formulas.map((f) => (
        <div key={f.id} className="rounded-md border border-line px-2 py-2">
          <div className="mb-1 flex items-center gap-2 text-caption text-fg-subtle">
            {f.latex ? <Badge tone="accent">LaTeX</Badge> : <Badge>{tr('原图')}</Badge>}
            {f.page && (
              <button
                type="button"
                className="ml-auto tabular-nums hover:text-fg"
                onClick={() => jump(f.page!, f.boxes)}
              >
                p.{f.page}
              </button>
            )}
          </div>
          <FormulaView formula={f} macros={s.macros} />
        </div>
      ))}
    </div>
  );
}

function Figures() {
  const { paper } = useReader();
  const s = paper.structure!;
  if (s.figures.length === 0) {
    return (
      <EmptyState
        icon={ImageIcon}
        title={tr('没有识别出图表')}
        description={tr('这篇论文里没有找到带图注的图或表。')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {s.figures.map((f) => (
        <FigureCard key={f.id} figure={f} />
      ))}
    </div>
  );
}

function FigureCard({ figure }: { figure: PaperFigure }) {
  const { doc, jump } = useReader();
  const [showCells, setShowCells] = useState(false);
  const area = figure.graphic ?? (figure.boxes.length ? unionBox(figure.boxes) : null);
  return (
    <figure className="rounded-md border border-line p-2">
      <div className="mb-1.5 flex items-center gap-2">
        {figure.kind === 'table' ? (
          <Table2 className="size-4 text-fg-muted" strokeWidth={1.75} aria-hidden />
        ) : (
          <ImageIcon className="size-4 text-fg-muted" strokeWidth={1.75} aria-hidden />
        )}
        <span className="text-small font-medium">
          {figure.label ?? (figure.kind === 'table' ? tr('表') : tr('图'))}
        </span>
        {figure.page && (
          <button
            type="button"
            className="ml-auto text-caption text-fg-subtle tabular-nums hover:text-fg"
            onClick={() => jump(figure.page!, figure.boxes)}
          >
            p.{figure.page}
          </button>
        )}
      </div>
      {area && <PdfCrop doc={doc} box={area} label={`${figure.label ?? ''} ${figure.caption}`} />}
      <figcaption className="mt-1.5 text-caption leading-relaxed text-fg-muted">
        {figure.caption}
      </figcaption>
      {figure.rows && figure.rows.length > 0 && (
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={() => setShowCells((v) => !v)}>
            {showCells
              ? tr('收起单元格')
              : tr('查看单元格（{count} 行）', { count: figure.rows.length })}
          </Button>
          {showCells && (
            <div className="mt-1 max-h-72 overflow-auto rounded-sm border border-line">
              <table className="w-full border-collapse text-caption">
                <tbody>
                  {figure.rows.map((r, i) => (
                    <tr key={i} className={i === 0 ? 'bg-subtle font-medium' : undefined}>
                      {r.map((c, j) => (
                        <td
                          key={j}
                          className="border-b border-line px-2 py-1 whitespace-nowrap tabular-nums"
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

function References() {
  const { paper } = useReader();
  const s = paper.structure!;
  if (s.references.length === 0) {
    return (
      <EmptyState
        icon={BookOpenText}
        title={tr('没有识别出参考文献')}
        description={tr('GROBID 没有找到参考文献列表。')}
      />
    );
  }
  return (
    <ol className="flex flex-col gap-2" aria-label={tr('参考文献')}>
      {s.references.map((r) => (
        <ReferenceItem key={r.id} r={r} />
      ))}
    </ol>
  );
}

function ReferenceItem({ r }: { r: PaperReference }) {
  const pid = usePersonalLibrary();
  const { jump } = useReader();
  const imp = useImportPaper(pid);
  const [done, setDone] = useState<string | null>(null);
  const target = r.arxivId
    ? { kind: 'arxiv' as const, value: r.arxivId }
    : r.doi
      ? { kind: 'doi' as const, value: r.doi }
      : null;
  return (
    <li className="rounded-md border border-line px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-caption text-fg-subtle tabular-nums">
          [{r.index}]
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium text-fg">{r.title ?? r.raw ?? tr('（无标题）')}</p>
          <p className="mt-0.5 text-caption text-fg-muted">
            {[
              r.authors.slice(0, 3).join(tr('、')) + (r.authors.length > 3 ? tr(' 等') : ''),
              r.venue,
              r.year,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {r.arxivId && <Badge>arXiv {r.arxivId}</Badge>}
            {r.doi && <Badge className="max-w-full truncate">DOI {r.doi}</Badge>}
            {r.page && (
              <button
                type="button"
                className="text-caption text-fg-subtle hover:text-fg"
                onClick={() => jump(r.page!, r.boxes)}
              >
                p.{r.page}
              </button>
            )}
            {target && (
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                loading={imp.isPending}
                disabled={Boolean(done)}
                leftIcon={done ? undefined : <Download strokeWidth={1.75} aria-hidden />}
                onClick={() =>
                  imp.mutate(target, {
                    onSuccess: (res) => {
                      setDone(res.paper.id);
                      toast({
                        tone: 'success',
                        title: res.duplicate ? tr('个人库里已经有这篇') : tr('已加入个人库'),
                        description: tr('仅自己可见，不会自动发布到项目'),
                      });
                    },
                    onError: (e) =>
                      toast({ tone: 'danger', title: tr('导入失败'), description: e.message }),
                  })
                }
              >
                {done ? tr('已存入个人库') : tr('存入个人库')}
              </Button>
            )}
            {done && (
              <Link
                to={libraryPath(pid, done)}
                className="inline-flex min-h-11 items-center text-caption text-accent-text hover:underline"
              >
                {tr('打开个人论文')}
              </Link>
            )}
            {!target && r.title && (
              <a
                className="ml-auto inline-flex items-center gap-1 text-caption text-accent-text hover:underline"
                href={`https://scholar.google.com/scholar?q=${encodeURIComponent(r.title)}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {tr('搜索 ')}
                <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
              </a>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
