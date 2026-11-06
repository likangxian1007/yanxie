import { memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseCitationMarkers, type CitationMarker } from '@srh/shared';
import { cn } from '@/lib/cn';
import { TexMath } from './TexMath';
import { tr } from '@/lib/i18n';

/**
 * 模型回答：Markdown + $公式$ + 引用标记 [p.5 ¶3] / [citekey, p.5 ¶3]。
 * 做法：先把公式和引用换成 `[i](#lib-math-i)` / `[i](#lib-cite-i)` 占位链接，
 * 让 react-markdown 正常排版，再在 a 组件里换回 KaTeX 和可点的引用标签。
 */
export interface ResolvedCite {
  label: string;
  /** null = 回答里写了、但来源里找不到对应段落 */
  onOpen: (() => void) | null;
  title?: string;
}

interface Props {
  text: string;
  resolve: (m: CitationMarker) => ResolvedCite;
  macros?: Record<string, string> | undefined;
  className?: string;
}

type Token =
  { kind: 'math'; tex: string; display: boolean } | { kind: 'cite'; marker: CitationMarker };

function encode(text: string): { md: string; tokens: Token[] } {
  const tokens: Token[] = [];
  // 1) 公式（$$…$$ 先于 $…$；\( \) \[ \] 也支持）
  let md = text.replace(
    /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/gu,
    (
      _m,
      a: string | undefined,
      b: string | undefined,
      c: string | undefined,
      d: string | undefined,
    ) => {
      const display = a !== undefined || b !== undefined;
      tokens.push({ kind: 'math', tex: (a ?? b ?? c ?? d ?? '').trim(), display });
      const link = `[${tokens.length - 1}](#lib-math-${tokens.length - 1})`;
      return display ? `\n\n${link}\n\n` : link;
    },
  );
  // 2) 引用
  const markers = parseCitationMarkers(md);
  let out = '';
  let last = 0;
  for (const m of markers) {
    out += md.slice(last, m.start);
    tokens.push({ kind: 'cite', marker: m });
    out += `[${tokens.length - 1}](#lib-cite-${tokens.length - 1})`;
    last = m.end;
  }
  md = out + md.slice(last);
  return { md, tokens };
}

export const RichAnswer = memo(function RichAnswer({ text, resolve, macros, className }: Props) {
  const { md, tokens } = useMemo(() => encode(text), [text]);
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const m = /^#lib-(math|cite)-(\d+)$/u.exec(href ?? '');
        const tok = m ? tokens[Number(m[2])] : undefined;
        if (tok?.kind === 'math')
          return <TexMath tex={tok.tex} display={tok.display} macros={macros} />;
        if (tok?.kind === 'cite') return <CiteChip cite={resolve(tok.marker)} />;
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent-text underline-offset-2 hover:underline"
          >
            {children as ReactNode}
          </a>
        );
      },
      p: ({ children }) => <p>{children}</p>,
      code: ({ children }) => (
        <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
      ),
    }),
    [tokens, resolve, macros],
  );
  return (
    <div
      className={cn(
        'min-w-0 break-words text-body text-fg',
        '[&_p]:my-[0.6em] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_ul]:my-[0.6em] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-[0.6em] [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-[0.2em]',
        '[&_h1]:text-h3 [&_h2]:text-h3 [&_h3]:font-semibold',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {md}
      </ReactMarkdown>
    </div>
  );
});

export function CiteChip({ cite }: { cite: ResolvedCite }) {
  if (!cite.onOpen) {
    return (
      <span className="lib-cite" data-missing="true" title={cite.title ?? tr('来源里没有这一段')}>
        {cite.label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="lib-cite"
      title={cite.title ?? tr('跳到原文')}
      onClick={cite.onOpen}
    >
      {cite.label}
    </button>
  );
}
