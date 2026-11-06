import { describe, expect, it } from 'vitest';
import { colorLightOf, keepColorLight, withColorLight } from './awareness';
import { findMathRanges } from './mathRanges';
import {
  buildBlockInsert,
  buildSnippetEdit,
  buildWrapEdit,
  expandTemplate,
  getSnippet,
  stripCodeFence,
  type TextEdit,
} from './snippets';

function apply(doc: string, e: TextEdit): { text: string; selected: string } {
  const text = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  const a = Math.min(e.selection.anchor, e.selection.head);
  const b = Math.max(e.selection.anchor, e.selection.head);
  return { text, selected: text.slice(a, b) };
}

describe('snippets · 插入片段', () => {
  it('展开模板占位符', () => {
    expect(expandTemplate('\\cite{${1:key}}', null)).toEqual({
      text: '\\cite{key}',
      start: 6,
      end: 9,
    });
    expect(expandTemplate('\\cite{${1:key}}', 'smith2020')).toEqual({
      text: '\\cite{smith2020}',
      start: 6,
      end: 15,
    });
    expect(expandTemplate('plain', null)).toEqual({ text: 'plain', start: 5, end: 5 });
  });

  it('空行处插入 section，并选中默认标题', () => {
    const doc = 'a\n\nb';
    const r = apply(doc, buildSnippetEdit(doc, 2, 2, getSnippet('section')));
    expect(r.text).toBe('a\n\\section{节标题}\nb');
    expect(r.selected).toBe('节标题');
  });

  it('行中插入块级片段时自动换行', () => {
    const doc = 'Text here';
    const r = apply(doc, buildSnippetEdit(doc, 4, 4, getSnippet('equation')));
    expect(r.text).toBe('Text\n\\begin{equation}\n  E = mc^2\n\\end{equation}\n here');
    expect(r.selected).toBe('E = mc^2');
  });

  it('沿用当前行缩进', () => {
    const doc = '  ';
    const r = apply(doc, buildSnippetEdit(doc, 2, 2, getSnippet('itemize')));
    expect(r.text).toBe(
      '  \\begin{itemize}\n    \\item 第一项\n    \\item 第二项\n  \\end{itemize}',
    );
    expect(r.selected).toBe('第一项');
  });

  it('有选区时选中文字进入占位符', () => {
    const doc = 'see smith2020 now';
    const r = apply(doc, buildSnippetEdit(doc, 4, 13, getSnippet('cite')));
    expect(r.text).toBe('see \\cite{smith2020} now');
    expect(r.selected).toBe('smith2020');
    const doc2 = 'Introduction';
    const r2 = apply(doc2, buildSnippetEdit(doc2, 0, doc2.length, getSnippet('section')));
    expect(r2.text).toBe('\\section{Introduction}');
  });

  it('figure / table / align 片段能被转换器正常渲染', async () => {
    const { renderLatex } = await import('../render/renderLatex');
    for (const id of ['figure', 'table', 'align', 'enumerate'] as const) {
      const doc = '';
      const r = apply(doc, buildSnippetEdit(doc, 0, 0, getSnippet(id)));
      const out = renderLatex(r.text);
      expect(out.warnings).toEqual([]);
    }
  });
});

describe('snippets · 加粗与斜体', () => {
  it('包裹选区', () => {
    const doc = 'a word here';
    const r = apply(doc, buildWrapEdit(doc, 2, 6, 'textbf'));
    expect(r.text).toBe('a \\textbf{word} here');
    expect(r.selected).toBe('word');
  });

  it('再次执行时去掉包裹（切换）', () => {
    const doc = 'a \\textbf{word} here';
    // 选中内部文字
    const r = apply(doc, buildWrapEdit(doc, 10, 14, 'textbf'));
    expect(r.text).toBe('a word here');
    expect(r.selected).toBe('word');
    // 选中整个命令
    const r2 = apply(doc, buildWrapEdit(doc, 2, 15, 'textbf'));
    expect(r2.text).toBe('a word here');
  });

  it('没有选区时插入默认文字并选中', () => {
    const r = apply('', buildWrapEdit('', 0, 0, 'textit'));
    expect(r.text).toBe('\\textit{斜体文字}');
    expect(r.selected).toBe('斜体文字');
  });
});

describe('snippets · AI 结果插入', () => {
  it('块级插入前后各留一个空行', () => {
    const doc = 'para one\nmore';
    const r = apply(doc, buildBlockInsert(doc, 8, '\\section{New}\nBody.\n'));
    expect(r.text).toBe('para one\n\n\\section{New}\nBody.\n\nmore');
    expect(r.selected).toBe('\\section{New}\nBody.');
  });

  it('去掉代码围栏', () => {
    expect(stripCodeFence('```latex\n\\section{A}\n```')).toBe('\\section{A}');
    expect(stripCodeFence('\\section{A}')).toBe('\\section{A}');
  });
});

describe('mathRanges', () => {
  it('找出行内、显示公式与数学环境，跳过注释和 verbatim', () => {
    const src =
      'a $x$ b \\(y\\) \\[z\\] % $no$\n\\begin{align}\nq % c\n\\end{align}\n\\begin{verbatim}$v$\\end{verbatim}';
    const ranges = findMathRanges(src).map(([a, b]) => src.slice(a, b));
    expect(ranges).toEqual(['$x$', '\\(y\\)', '\\[z\\]', '\\begin{align}\nq ', '\\end{align}']);
  });

  it('转义的 \\$ 不算公式，空行结束未闭合的行内公式', () => {
    const src = 'cost \\$5 and $a\n\nb$';
    const ranges = findMathRanges(src).map(([a, b]) => src.slice(a, b));
    expect(ranges).toEqual(['$a', '$']);
  });
});

describe('awareness colorLight', () => {
  it('给 var() 颜色补上 color-mix 半透明', () => {
    const u = withColorLight({ name: '林', color: 'var(--palette-2)' });
    expect(u?.colorLight).toBe(colorLightOf('var(--palette-2)'));
    expect(withColorLight(u)).toBeNull();
    expect(withColorLight(null)).toBeNull();
    expect(withColorLight({ name: 'x' })).toBeNull();
  });

  it('本地 user 被外部覆盖后再补一次，不会死循环', () => {
    type Cb = (c: { added: number[]; updated: number[] }) => void;
    const listeners = new Set<Cb>();
    let state: Record<string, unknown> = { user: { name: 'A', color: 'var(--palette-1)' } };
    let writes = 0;
    const aw = {
      clientID: 7,
      getLocalState: () => state,
      setLocalStateField: (k: string, v: unknown) => {
        writes += 1;
        state = { ...state, [k]: v };
        listeners.forEach((l) => l({ added: [], updated: [7] }));
      },
      on: (_e: 'change', cb: Cb) => listeners.add(cb),
      off: (_e: 'change', cb: Cb) => listeners.delete(cb),
    };
    const stop = keepColorLight(aw);
    expect(writes).toBe(1);
    expect((state.user as { colorLight?: string }).colorLight).toContain('color-mix');
    // 外层重写 user（丢掉 colorLight）
    state = { user: { name: 'A', color: 'var(--palette-3)' } };
    listeners.forEach((l) => l({ added: [], updated: [7] }));
    expect(writes).toBe(2);
    expect((state.user as { colorLight?: string }).colorLight).toContain('palette-3');
    stop();
    expect(listeners.size).toBe(0);
  });
});
