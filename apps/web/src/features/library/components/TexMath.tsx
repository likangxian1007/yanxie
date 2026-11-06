import { memo, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { cn } from '@/lib/cn';

/** KaTeX 渲染（宏来自论文 LaTeX 源码）；渲染失败时显示原文 */
export const TexMath = memo(function TexMath({
  tex,
  display = false,
  macros,
  className,
}: {
  tex: string;
  display?: boolean;
  macros?: Record<string, string> | undefined;
  className?: string;
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml',
        // KaTeX 会往 macros 里写（\gdef），每次给一份拷贝
        macros: { ...(macros ?? {}) },
      });
    } catch {
      return null;
    }
  }, [tex, display, macros]);
  if (!html) {
    return <code className={cn('font-mono text-small text-fg-muted', className)}>{tex}</code>;
  }
  const Tag = display ? 'div' : 'span';
  return (
    <Tag
      className={cn('lib-katex', display && 'max-w-full overflow-x-auto', className)}
      // KaTeX 输出是转义过的 HTML（trust: false）
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
