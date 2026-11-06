import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { parseBib, type BibEntry } from '../compile/bib';
import { renderLatex } from '../render/renderLatex';
import type { LatexRenderResult } from '../render/types';
import { tr } from '@/lib/i18n';

export const PREVIEW_DEBOUNCE_MS = 300;

const EMPTY: LatexRenderResult = {
  html: '',
  blocks: [],
  outline: [],
  sections: [],
  warnings: [],
  title: null,
};

/**
 * 订阅 Y.Text（main.tex）和工程文件表，停止输入 300ms 后重新转换（本地输入、远程协作者、agent 的改动都会触发）。
 * 工程里的 .bib 文件会被解析，给草稿预览的 \cite 编号、列参考文献。
 * 返回最近一次的转换结果和“是否有待刷新的改动”。
 */
export function useLatexRender(
  ytext: Y.Text,
  files?: Y.Map<Y.Text>,
): { result: LatexRenderResult; pending: boolean } {
  const [result, setResult] = useState<LatexRenderResult>(() =>
    safeRender(ytext.toString(), collectBib(files)),
  );
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      setResult(safeRender(ytext.toString(), collectBib(files)));
      setPending(false);
    };
    const onChange = () => {
      setPending(true);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, PREVIEW_DEBOUNCE_MS);
    };
    // 挂载到订阅之间 ytext 可能已经变了（初次同步）：下一拍再算一遍
    timer = window.setTimeout(flush, 0);
    ytext.observe(onChange);
    files?.observeDeep(onChange);
    return () => {
      ytext.unobserve(onChange);
      files?.unobserveDeep(onChange);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ytext, files]);

  return { result, pending };
}

function collectBib(files: Y.Map<Y.Text> | undefined): Record<string, BibEntry[]> | undefined {
  if (!files) return undefined;
  const out: Record<string, BibEntry[]> = {};
  files.forEach((v, name) => {
    if (v instanceof Y.Text && /\.bib$/iu.test(name)) out[name] = parseBib(v.toString()).entries;
  });
  return out;
}

function safeRender(
  source: string,
  bib: Record<string, BibEntry[]> | undefined,
): LatexRenderResult {
  try {
    return renderLatex(source, bib ? { bib } : {});
  } catch (err) {
    // 转换器自身的 bug 不应该拖垮编辑器：显示一条警告
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...EMPTY,
      warnings: [{ line: 1, message: tr('预览转换出错：{message}', { message }) }],
    };
  }
}
