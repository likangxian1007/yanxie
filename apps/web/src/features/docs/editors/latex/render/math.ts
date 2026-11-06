import katex from 'katex';
import { escapeHtml } from './text';
import { tr } from '@/lib/i18n';

/**
 * KaTeX 渲染（带缓存）。同一个公式在每次预览刷新时都会再渲染一遍，
 * 缓存让 3000 行、几百个公式的论文也只在公式变化时才付出代价。
 */

export interface MathResult {
  html: string;
  /** 出错时：中文说明 + 在 tex 里的偏移（用于算行号） */
  error: { message: string; offset: number } | null;
}

const CACHE_LIMIT = 4000;
const cache = new Map<string, MathResult>();

export function renderMath(
  tex: string,
  display: boolean,
  macros: Record<string, string>,
  macrosKey: string,
): MathResult {
  const key = `${display ? 'D' : 'I'}\u0001${macrosKey}\u0001${tex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: MathResult;
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
      // KaTeX 会往 macros 里写 \gdef 的结果，传副本
      macros: { ...macros },
      maxExpand: 500,
    });
    result = { html, error: null };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const rawMessage =
      err && typeof err === 'object' && 'rawMessage' in err
        ? String((err as { rawMessage: unknown }).rawMessage)
        : raw;
    const position =
      err && typeof err === 'object' && 'position' in err
        ? Number((err as { position: unknown }).position)
        : 0;
    const message = translateKatexError(rawMessage);
    const tag = display ? 'div' : 'span';
    result = {
      html: `<${tag} class="ltx-math-error" title="${escapeHtml(message)}">${escapeHtml(tex)}</${tag}>`,
      error: { message, offset: Number.isFinite(position) ? position : 0 },
    };
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}

/** 把 KaTeX 的英文报错翻成一句中文（认不出的保留原文）。 */
export function translateKatexError(raw: string): string {
  const undefinedCs = /Undefined control sequence: (\\\S+)/.exec(raw);
  if (undefinedCs) return tr('公式里有未定义的命令 {value}', { value: undefinedCs[1] });
  if (/Expected '\}'|Unexpected end of input|Expected group|Missing open brace|Extra \}/i.test(raw))
    return tr('公式的花括号没有配对');
  if (/Expected '\\right'|Expected '\\end'|Mismatched/i.test(raw))
    return tr('公式里的 \\left / \\right 或 \\begin / \\end 没有配对');
  if (/No such environment: (\S+)/.test(raw)) {
    const env = /No such environment: (\S+)/.exec(raw)?.[1] ?? '';
    return tr('公式里用了预览不支持的环境 {env}', { env });
  }
  if (/Double (superscript|subscript)/.test(raw))
    return tr('公式里连续出现了两个上标或下标，请用花括号分组');
  if (/Can't use function '\$' in math mode/.test(raw)) return tr('公式里多了一个 $');
  if (/Unknown column alignment/.test(raw)) return tr('矩阵或对齐环境的列格式不正确');
  if (/Too many tab characters/.test(raw)) return tr('对齐环境里的 & 太多了');
  return tr('公式有误：{raw}', { raw: raw.replace(/^KaTeX parse error:\s*/, '') });
}
