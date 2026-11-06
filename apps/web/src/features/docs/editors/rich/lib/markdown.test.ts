import { describe, expect, it } from 'vitest';
import { generateJSON, type JSONContent } from '@tiptap/core';
import { contentExtensions } from '../extensions';
import { markdownToHtml, stripMarkdownFence } from './markdown';

const exts = contentExtensions();
const toJSON = (html: string) => generateJSON(html, exts) as JSONContent;

function parse(html: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const div = document.createElement('div');
  div.appendChild(tpl.content);
  return div;
}

function types(node: JSONContent, out: string[] = []): string[] {
  if (node.type) out.push(node.type);
  for (const child of node.content ?? []) types(child, out);
  return out;
}

describe('markdownToHtml', () => {
  it('常见块：标题、列表、引用、代码、表格', () => {
    const { html, inline } = markdownToHtml(
      [
        '## 方法',
        '',
        '- 第一点',
        '- 第二点',
        '',
        '1. 一',
        '2. 二',
        '',
        '> 引用',
        '',
        '```python',
        'print(1)',
        '```',
        '',
        '| 模型 | 准确率 |',
        '| --- | --- |',
        '| A | 0.91 |',
        '',
        '---',
      ].join('\n'),
    );
    expect(inline).toBe(false);
    const t = types(toJSON(html));
    for (const name of [
      'heading',
      'bulletList',
      'orderedList',
      'listItem',
      'blockquote',
      'codeBlock',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
      'horizontalRule',
    ]) {
      expect(t).toContain(name);
    }
    const code = toJSON(html).content?.find((n) => n.type === 'codeBlock');
    expect(code?.attrs?.language).toBe('python');
  });

  it('行内标记', () => {
    const { html } = markdownToHtml('**粗** *斜* ~~删~~ `码` [链接](https://example.com)');
    const json = JSON.stringify(toJSON(html));
    for (const mark of ['bold', 'italic', 'strike', 'code', 'link']) {
      expect(json).toContain(`"type":"${mark}"`);
    }
    expect(json).toContain('https://example.com');
  });

  it('GFM 任务列表 → taskList / taskItem(checked)', () => {
    const { html } = markdownToHtml('- [x] 已完成\n- [ ] 待处理');
    expect(html).toContain('data-type="taskList"');
    expect(html).not.toContain('<input');
    const list = toJSON(html).content?.[0];
    expect(list?.type).toBe('taskList');
    expect(list?.content?.map((i) => [i.type, i.attrs?.checked])).toEqual([
      ['taskItem', true],
      ['taskItem', false],
    ]);
    expect(JSON.stringify(list)).toContain('已完成');
  });

  it('公式：$…$ 行内、$$…$$ 公式块；货币不误判', () => {
    const { html } = markdownToHtml(
      '质能方程 $E=mc^2$ 很有名。\n\n$$\n\\sum_{i=1}^n x_i\n$$\n\n价格 $5 到 $10。',
    );
    const json = toJSON(html);
    const t = types(json);
    expect(t).toContain('inlineMath');
    expect(t).toContain('blockMath');
    const str = JSON.stringify(json);
    expect(str).toContain('E=mc^2');
    expect(str).toContain('\\\\sum_{i=1}^n x_i');
    expect(str).toContain('价格 $5 到 $10');
  });

  it('代码里的 $ 不当公式', () => {
    const { html } = markdownToHtml('运行 `echo $HOME$` 即可');
    expect(html).not.toContain('inline-math');
  });

  it('单段落 + preferInline → 去掉 <p> 外壳', () => {
    const r = markdownToHtml('改写后的**一句话**', true);
    expect(r.inline).toBe(true);
    expect(r.html).toBe('改写后的<strong>一句话</strong>');
    const multi = markdownToHtml('第一段\n\n第二段', true);
    expect(multi.inline).toBe(false);
    expect(multi.html).toContain('<p>第二段</p>');
  });

  it('剥掉整段 ```markdown 围栏', () => {
    expect(stripMarkdownFence('```markdown\n# 标题\n```')).toBe('# 标题');
    expect(stripMarkdownFence('```\n正文\n```\n')).toBe('正文');
    expect(stripMarkdownFence('正文 ```x```')).toBe('正文 ```x```');
    expect(markdownToHtml('```md\n**粗**\n```').html).toBe('<p><strong>粗</strong></p>');
  });

  it('XSS 清洗：脚本、事件属性、javascript: 链接、iframe、style', () => {
    const { html } = markdownToHtml(
      [
        '<script>alert(1)</script>',
        '',
        '<img src=x onerror="alert(1)">',
        '',
        '[点我](javascript:alert(1))',
        '',
        '<a href="javascript:alert(1)" onclick="alert(1)">a</a>',
        '',
        '<iframe src="https://evil.example"></iframe>',
        '',
        '<p style="color:red" onmouseover="alert(1)">文字</p>',
        '',
        '<svg><script>alert(1)</script></svg>',
        '',
        '<div data-type="block-math" data-latex="x&quot; onerror=&quot;alert(1)"></div>',
      ].join('\n'),
    );
    const root = parse(html);
    // 图片现在是合法节点：保留 src，事件属性被去掉（下面逐个属性检查）
    expect(root.querySelector('script, iframe, style')).toBeNull();
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name).not.toMatch(/^on|^style$/i);
        if (attr.name === 'href') expect(attr.value).not.toMatch(/^\s*javascript:/i);
      }
    }
    expect(root.textContent).toContain('文字');
    // 属性值里的 “onerror=” 只是文字（已转义），不是属性
    expect(root.querySelector('[data-type="block-math"]')?.getAttribute('data-latex')).toBe(
      'x" onerror="alert(1)',
    );
  });

  it('公式里的引号被转义，不会逃出属性', () => {
    const { html } = markdownToHtml('$a" onload="x$');
    const span = parse(html).querySelector('[data-type="inline-math"]');
    expect(span?.getAttributeNames().sort()).toEqual(['data-latex', 'data-type']);
    expect(span?.getAttribute('data-latex')).toBe('a" onload="x');
    expect(JSON.stringify(toJSON(html))).toContain('inlineMath');
  });

  it('空输入', () => {
    expect(markdownToHtml('   ').html).toBe('');
  });

  it('AI 写的图片、@提及、内嵌文档变成对应节点（与服务端 markdown 约定一致）', () => {
    const { html } = markdownToHtml(
      [
        '见下图',
        '',
        '![曲线](/api/v1/projects/p/files/fil_1)',
        '',
        '请 [@王老师](mention:usr_adv) 过目',
        '',
        '[嵌入表格：实验数据](doc:doc_S)',
      ].join('\n'),
    );
    const json = toJSON(html);
    const all = types(json);
    expect(all).toContain('image');
    expect(all).toContain('mention');
    expect(all).toContain('docEmbed');
    const find = (t: string, n: JSONContent = json): JSONContent | undefined =>
      n.type === t ? n : (n.content ?? []).map((c) => find(t, c)).find(Boolean);
    expect(find('mention')?.attrs).toMatchObject({ id: 'usr_adv', label: '王老师' });
    expect(find('docEmbed')?.attrs).toMatchObject({
      docId: 'doc_S',
      kind: 'sheet',
      title: '实验数据',
    });
    expect(find('image')?.attrs).toMatchObject({
      src: '/api/v1/projects/p/files/fil_1',
      alt: '曲线',
    });
  });
});
