import { tr } from '@/lib/i18n';
/**
 * 工具栏“插入”与加粗 / 斜体：纯函数，输入文档文本和选区，输出一次编辑（from/to/insert）和插入后的选区。
 * 编辑器层把结果 dispatch 成一个 CodeMirror 事务，yCollab 同步给其他人。
 *
 * 模板里 ${1:默认文字} 是占位：有选区时用选中的文字替换它，否则插入默认文字并选中，方便直接改写。
 */

export type SnippetId =
  | 'section'
  | 'subsection'
  | 'equation'
  | 'align'
  | 'figure'
  | 'table'
  | 'itemize'
  | 'enumerate'
  | 'cite';

export interface Snippet {
  id: SnippetId;
  label: string;
  description: string;
  /** 块级：独占一行（必要时在前后补换行） */
  block: boolean;
  template: string;
}

export const SNIPPETS: Snippet[] = [
  {
    id: 'section',
    label: tr('小节'),
    description: '\\section{…}',
    block: true,
    template: tr('\\section{${1:节标题}}'),
  },
  {
    id: 'subsection',
    label: tr('子小节'),
    description: '\\subsection{…}',
    block: true,
    template: tr('\\subsection{${1:子节标题}}'),
  },
  {
    id: 'equation',
    label: tr('公式'),
    description: tr('带编号的 equation 环境'),
    block: true,
    template: '\\begin{equation}\n  ${1:E = mc^2}\n\\end{equation}',
  },
  {
    id: 'align',
    label: tr('多行对齐公式'),
    description: tr('align 环境，用 & 对齐'),
    block: true,
    template: '\\begin{align}\n  ${1:a &= b + c} \\\\\n  d &= e + f\n\\end{align}',
  },
  {
    id: 'figure',
    label: tr('图'),
    description: 'figure + includegraphics + caption',
    block: true,
    template: tr(
      '\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${1:figures/example.pdf}}\n  \\caption{图注}\n  \\label{fig:example}\n\\end{figure}',
    ),
  },
  {
    id: 'table',
    label: tr('表格'),
    description: tr('table + tabular 三列表'),
    block: true,
    template: tr(
      '\\begin{table}[t]\n  \\centering\n  \\caption{${1:表注}}\n  \\label{tab:example}\n  \\begin{tabular}{lcc}\n    \\hline\n    方法 & 指标 A & 指标 B \\\\\n    \\hline\n    基线 & 0.00 & 0.00 \\\\\n    本文 & 0.00 & 0.00 \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}',
    ),
  },
  {
    id: 'itemize',
    label: tr('无序列表'),
    description: tr('itemize 环境'),
    block: true,
    template: tr('\\begin{itemize}\n  \\item ${1:第一项}\n  \\item 第二项\n\\end{itemize}'),
  },
  {
    id: 'enumerate',
    label: tr('有序列表'),
    description: tr('enumerate 环境'),
    block: true,
    template: tr('\\begin{enumerate}\n  \\item ${1:第一项}\n  \\item 第二项\n\\end{enumerate}'),
  },
  {
    id: 'cite',
    label: tr('引用文献'),
    description: '\\cite{key}',
    block: false,
    template: '\\cite{${1:key}}',
  },
];

export function getSnippet(id: SnippetId): Snippet {
  const s = SNIPPETS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown snippet ${id}`);
  return s;
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  /** 编辑之后的选区（文档坐标） */
  selection: { anchor: number; head: number };
}

const PLACEHOLDER = /\$\{1(?::([^}]*))?\}/;

/** 展开模板：返回文本和占位符在文本里的区间 */
export function expandTemplate(
  template: string,
  replacement: string | null,
): { text: string; start: number; end: number } {
  const m = PLACEHOLDER.exec(template);
  if (!m) return { text: template, start: template.length, end: template.length };
  const fill = replacement ?? m[1] ?? '';
  const text = template.slice(0, m.index) + fill + template.slice(m.index + m[0].length);
  return { text, start: m.index, end: m.index + fill.length };
}

function lineBounds(doc: string, pos: number): { start: number; end: number } {
  const start = doc.lastIndexOf('\n', pos - 1) + 1;
  const nl = doc.indexOf('\n', pos);
  return { start, end: nl === -1 ? doc.length : nl };
}

/**
 * 在选区处插入代码片段。块级片段会独占一行，并沿用当前行的缩进；
 * 有选区时选中的文字填进占位符。
 */
export function buildSnippetEdit(
  doc: string,
  from: number,
  to: number,
  snippet: Snippet,
): TextEdit {
  const a = Math.max(0, Math.min(from, to, doc.length));
  const b = Math.min(doc.length, Math.max(from, to));
  const selected = b > a ? doc.slice(a, b) : null;
  // 块级片段里，多行选区不适合塞进单行占位符（如 \section{}），只取第一行
  const replacement =
    selected !== null && snippet.block && snippet.id.endsWith('section')
      ? (selected.split('\n')[0] ?? '').trim()
      : selected;
  let { text, start, end } = expandTemplate(snippet.template, replacement);

  if (snippet.block) {
    const line = lineBounds(doc, a);
    const indent = /^[ \t]*/.exec(doc.slice(line.start, line.end))?.[0] ?? '';
    if (indent) {
      const lines = text.split('\n');
      const indented = lines.map((l, i) => (i === 0 || l === '' ? l : indent + l)).join('\n');
      // 重新定位占位符：在第一行之后的部分，每经过一个换行多了 indent 长度
      const shift = (pos: number) => {
        const before = text.slice(0, pos);
        const breaks = (before.match(/\n/g) ?? []).length;
        return pos + breaks * indent.length;
      };
      start = shift(start);
      end = shift(end);
      text = indented;
    }
    const beforeText = doc.slice(line.start, a);
    const afterText = doc.slice(b, lineBounds(doc, b).end);
    let prefix = '';
    let suffix = '';
    if (beforeText.trim() !== '') prefix = `\n${indent}`;
    if (afterText.trim() !== '') suffix = `\n${indent}`;
    text = prefix + text + suffix;
    start += prefix.length;
    end += prefix.length;
  }

  return {
    from: a,
    to: b,
    insert: text,
    selection: { anchor: a + start, head: a + end },
  };
}

export type WrapCommand = 'textbf' | 'textit' | 'emph' | 'texttt' | 'underline';

const WRAP_DEFAULT: Record<WrapCommand, string> = {
  textbf: tr('粗体文字'),
  textit: tr('斜体文字'),
  emph: tr('强调文字'),
  texttt: 'code',
  underline: tr('下划线文字'),
};

/**
 * 用 \cmd{…} 包裹选区；选区本身已经是 \cmd{…}、或者紧挨着 \cmd{ 和 } 时则去掉包裹（切换）。
 * 没有选区时插入 \cmd{默认文字} 并选中默认文字。
 */
export function buildWrapEdit(doc: string, from: number, to: number, cmd: WrapCommand): TextEdit {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(doc.length, Math.max(from, to));
  const open = `\\${cmd}{`;
  const selected = doc.slice(a, b);

  // 选区就是 \cmd{…}
  if (
    selected.startsWith(open) &&
    selected.endsWith('}') &&
    balanced(selected.slice(open.length, -1))
  ) {
    const inner = selected.slice(open.length, -1);
    return { from: a, to: b, insert: inner, selection: { anchor: a, head: a + inner.length } };
  }
  // 选区外面紧挨着 \cmd{ 和 }
  if (b > a && doc.slice(a - open.length, a) === open && doc[b] === '}' && balanced(selected)) {
    return {
      from: a - open.length,
      to: b + 1,
      insert: selected,
      selection: { anchor: a - open.length, head: a - open.length + selected.length },
    };
  }
  const body = b > a ? selected : WRAP_DEFAULT[cmd];
  const insert = `${open}${body}}`;
  return {
    from: a,
    to: b,
    insert,
    selection: { anchor: a + open.length, head: a + open.length + body.length },
  };
}

function balanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * 把 AI 生成的块级 LaTeX（小节）插到光标处：保证前后各有一个空行，结果独立成段。
 */
export function buildBlockInsert(doc: string, pos: number, block: string): TextEdit {
  const p = Math.max(0, Math.min(pos, doc.length));
  const body = block.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const before = doc.slice(0, p);
  const after = doc.slice(p);
  let prefix = '';
  if (before.length > 0 && !before.endsWith('\n\n')) prefix = before.endsWith('\n') ? '\n' : '\n\n';
  let suffix = '';
  if (after.length > 0 && !after.startsWith('\n\n'))
    suffix = after.startsWith('\n') ? '\n' : '\n\n';
  else if (after.length === 0) suffix = '\n';
  const insert = prefix + body + suffix;
  const start = p + prefix.length;
  return { from: p, to: p, insert, selection: { anchor: start, head: start + body.length } };
}

/** 去掉 AI 偶尔包上的 ```latex 代码围栏 */
export function stripCodeFence(text: string): string {
  const m = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? (m[1] ?? '') : text;
}
