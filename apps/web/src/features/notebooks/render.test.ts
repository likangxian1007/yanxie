import { describe, expect, it } from 'vitest';
import { fixConsole, renderMarkdown, sanitizeOutputHtml } from './render';

function dom(html: string) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('renderMarkdown 公式', () => {
  it('保留 KaTeX 定位用的内联 style（上下标不再错位）', () => {
    const el = dom(renderMarkdown('勾股定理 $x_i^2$ 成立'));
    const katex = el.querySelector('.katex');
    expect(katex).not.toBeNull();
    // KaTeX 用 vlist 的 style="top:…" / strut 的 style="height:…" 做上下标定位
    const styled = Array.from(el.querySelectorAll('.katex-html [style]')).map((n) =>
      n.getAttribute('style'),
    );
    expect(styled.some((s) => /height:/.test(s ?? ''))).toBe(true);
    expect(styled.some((s) => /top:/.test(s ?? ''))).toBe(true);
    expect(el.querySelector('.msupsub')).not.toBeNull();
    expect(el.textContent).toContain('勾股定理');
    expect(el.textContent).toContain('成立');
  });

  it('显示公式 $$\\frac{a}{b}$$ 和 \\sum_{i=1}^n 正常排版', () => {
    const el = dom(renderMarkdown('$$\\frac{a}{b}$$\n\n求和 $\\sum_{i=1}^n i$'));
    expect(el.querySelector('.katex-display .mfrac')).not.toBeNull();
    expect(el.querySelector('.mfrac .frac-line')?.getAttribute('style')).toMatch(/border-bottom/);
    expect(el.querySelectorAll('.katex').length).toBe(2);
    expect(el.querySelector('.katex .op-symbol')).not.toBeNull();
    // MathML 语义（读屏用）也保留
    expect(el.querySelector('annotation')?.textContent).toBe('\\frac{a}{b}');
  });

  it('代码里的 $ 不当公式', () => {
    const el = dom(renderMarkdown('`$a^2$` 和 $b$'));
    expect(el.querySelector('code')?.textContent).toBe('$a^2$');
    expect(el.querySelectorAll('.katex').length).toBe(1);
  });

  it('用户手写 HTML 仍然去掉 style、脚本和事件', () => {
    const html = renderMarkdown(
      '<span style="position:fixed;inset:0">盖住</span> <img src=x onerror="window.__x=1"><script>window.__y=1</script> $a$',
    );
    const el = dom(html);
    expect(el.querySelector('span[style*="fixed"]')).toBeNull();
    expect(html).not.toMatch(/onerror|<script/i);
    expect(el.querySelector('.katex')).not.toBeNull();
  });

  it('属性里的公式占位符换回原文，不插入 HTML', () => {
    const el = dom(renderMarkdown('[链接]($javascript:alert(1)$)'));
    const a = el.querySelector('a');
    if (a) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
      expect(a.getAttribute('href') ?? '').not.toContain('<');
    }
    expect(el.innerHTML).not.toContain('\uE000');
  });

  it('KaTeX 不认 \\href（trust 关闭）', () => {
    const html = renderMarkdown('$\\href{javascript:alert(1)}{x}$');
    expect(html).not.toMatch(/href="javascript/i);
  });
});

describe('输出净化', () => {
  it('HTML 输出去掉 script 和 onerror', () => {
    const html = sanitizeOutputHtml(
      '<img src="x" onerror="window.__xss=1"><script>window.__xss2=1</script><b>ok</b>',
    );
    expect(html).not.toMatch(/onerror|<script/i);
    expect(html).toContain('<b>ok</b>');
  });
});

describe('fixConsole（tqdm 文本进度条）', () => {
  it('\\r 之后的内容原地覆盖', () => {
    expect(fixConsole('  0%|   | 0/20\r 50%|#  | 10/20\r100%|###| 20/20\n')).toBe(
      '100%|###| 20/20\n',
    );
  });
  it('服务端保留的行尾 \\r 不吞掉当前内容', () => {
    expect(fixConsole(' 40%|##   | 8/20\r')).toBe(' 40%|##   | 8/20');
  });
});
