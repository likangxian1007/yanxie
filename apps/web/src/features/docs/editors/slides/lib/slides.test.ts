import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  draftsToSlides,
  getDeckMeta,
  readAllSlides,
  readDeckInfo,
  replaceAllWithDrafts,
  slideToDraft,
} from '../model';
import { pmPlainText } from '../model/richtext';
import { parseBody, parseInline } from './body';
import { inferLayout, parseSlidesMarkdown, slidesToMarkdown, splitColumns } from './markdown';

const DECK = `## 视觉 Transformer 组会汇报
张三 · 2026 年 10 月

## 本周进展
- 复现 **ViT-B/16**，Top-1 达到 $81.2\\%$
- 消融：patch size 对精度的影响
  - 16 优于 32
> 先讲复现，再讲消融

## 实验结果

## 对比
左栏：ResNet
|||
右栏：ViT
> 强调 ViT 的数据需求
> 第二行备注
`;

describe('parseSlidesMarkdown', () => {
  it('splits pages on ## and infers layouts', () => {
    const slides = parseSlidesMarkdown(DECK);
    expect(slides.map((s) => s.title)).toEqual([
      '视觉 Transformer 组会汇报',
      '本周进展',
      '实验结果',
      '对比',
    ]);
    expect(slides.map((s) => s.layout)).toEqual(['title', 'content', 'section', 'two-column']);
    expect(slides[0]?.body).toBe('张三 · 2026 年 10 月');
    expect(slides[1]?.notes).toBe('先讲复现，再讲消融');
    expect(slides[1]?.body).toContain('  - 16 优于 32');
    expect(slides[3]?.notes).toBe('强调 ViT 的数据需求\n第二行备注');
  });
  it('treats content before the first ## as a page with # title', () => {
    const slides = parseSlidesMarkdown('# 开题报告\n李四\n\n## 背景\n- 一\n- 二');
    expect(slides[0]).toMatchObject({ title: '开题报告', body: '李四', layout: 'title' });
    expect(slides[1]).toMatchObject({ title: '背景', layout: 'content' });
  });
  it('does not split on ### and honours layout comments', () => {
    const slides = parseSlidesMarkdown(
      '## A\n### 小标题\n- x\n\n## B\n<!-- layout: section -->\n- y',
    );
    expect(slides).toHaveLength(2);
    expect(slides[0]?.body).toBe('### 小标题\n- x');
    expect(slides[1]?.layout).toBe('section');
    expect(slides[1]?.body).toBe('- y');
  });
  it('first page with a list is content, not title', () => {
    expect(parseSlidesMarkdown('## A\n- x')[0]?.layout).toBe('content');
  });
  it('strips an outer code fence and CRLF', () => {
    const slides = parseSlidesMarkdown('```markdown\r\n## A\r\n- x\r\n```');
    expect(slides).toEqual([{ title: 'A', body: '- x', notes: '', layout: 'content' }]);
  });
  it('handles partial streaming output', () => {
    expect(parseSlidesMarkdown('## 第一页\n- 进')).toHaveLength(1);
    expect(parseSlidesMarkdown('')).toEqual([]);
  });
  it('round-trips through slidesToMarkdown', () => {
    const slides = parseSlidesMarkdown(DECK);
    const custom = [...slides, { title: '', body: '', notes: '', layout: 'content' as const }];
    const md = slidesToMarkdown(custom);
    expect(parseSlidesMarkdown(md)).toEqual(custom);
  });
});

describe('AI / markdown 草稿插入（与服务端共用 @srh/shared 的规划）', () => {
  const MARP = `---
marp: true
---

# 组会汇报
林晓 · 2026 年 10 月

---

# 方法
- 编码器：MLP
  - 投影头 128→64
- 评测：**5-way** 1-shot / 5-shot

---

# 结果

| 方法 | 1-shot | 5-shot |
| --- | --- | --- |
| SupCon | **70.69** | 85.89 |
| ProtoNet | 59.93 | 74.95 |

<!-- 先讲 5-shot -->
`;
  it('Marp 风格：--- 分页、只有封面是标题页、表格是 table 元素、不留字面符号', () => {
    const drafts = parseSlidesMarkdown(MARP);
    expect(drafts.map((d) => [d.title, d.layout])).toEqual([
      ['组会汇报', 'title'],
      ['方法', 'content'],
      ['结果', 'content'],
    ]);
    const doc = new Y.Doc();
    replaceAllWithDrafts(doc, drafts, null);
    const deck = readDeckInfo(getDeckMeta(doc));
    const slides = readAllSlides(doc, deck);
    expect(slides.map((s) => s.layout)).toEqual(['title', 'content', 'title-only']);
    const table = slides[2]!.elements.find((e) => e.type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(table.cells.map((r) => r.map((c) => c.text))).toEqual([
      ['方法', '1-shot', '5-shot'],
      ['SupCon', '70.69', '85.89'],
      ['ProtoNet', '59.93', '74.95'],
    ]);
    expect(table.cells[1]![1]!.bold).toBe(true);
    expect(slides[2]!.notes).toBe('先讲 5-shot');
    for (const s of slides) {
      for (const e of s.elements) {
        expect(e.x + e.w).toBeLessThanOrEqual(deck.width + 0.01);
        expect(e.y + e.h).toBeLessThanOrEqual(deck.height + 0.01);
        if (e.type === 'text' || e.type === 'shape') {
          const t = pmPlainText(e.doc);
          expect(t).not.toMatch(/^\s*(---|\|)/mu);
          expect(t).not.toContain('**');
        }
      }
    }
    // 二级列表保留
    const body = slides[1]!.elements.find((e) => e.ph === 'body');
    expect(JSON.stringify(body?.type === 'text' ? body.doc : null)).toMatch(
      /"bulletList".*"listItem".*"bulletList"/u,
    );
    // 导出 markdown 再解析：页数、版式不变
    const md = slidesToMarkdown(slides.map(slideToDraft));
    expect(md).toContain('| 方法 | 1-shot | 5-shot |');
    expect(md).toContain('| SupCon | **70.69** | 85.89 |');
    expect(parseSlidesMarkdown(md).map((d) => d.layout)).toEqual(['title', 'content', 'content']);
  });
  it('长表在插入时拆成续页', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `| m${i} | ${i} |`).join('\n');
    const slides = draftsToSlides(parseSlidesMarkdown(`## 大表\n| a | b |\n|---|---|\n${rows}`));
    expect(slides).toHaveLength(3);
    expect(slides.every((s) => s.elements?.some((e) => e.type === 'table'))).toBe(true);
  });
});

describe('layout helpers', () => {
  it('infers layouts', () => {
    expect(inferLayout(0, '')).toBe('title');
    expect(inferLayout(3, '')).toBe('section');
    expect(inferLayout(1, 'a\n|||\nb')).toBe('two-column');
    expect(inferLayout(0, '- a')).toBe('content');
  });
  it('splits columns', () => {
    expect(splitColumns('- a\n- b\n|||\n- c')).toEqual(['- a\n- b', '- c']);
    expect(splitColumns('only')).toEqual(['only', '']);
  });
});

describe('parseBody', () => {
  it('parses inline bold, math and code', () => {
    expect(parseInline('精度 **81.2%**，公式 $E=mc^2$ 与 `code`，价格 \\$5')).toEqual([
      { text: '精度 ' },
      { text: '81.2%', bold: true },
      { text: '，公式 ' },
      { text: 'E=mc^2', math: true },
      { text: ' 与 ' },
      { text: 'code', code: true },
      { text: '，价格 $5' },
    ]);
  });
  it('parses lists, levels, ordered numbers and paragraphs', () => {
    const blocks = parseBody('导语第一行\n第二行\n\n- 一\n  - 一点一\n1. 甲\n2. 乙\n# 小结');
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'li', 'li', 'li', 'li', 'h']);
    expect(blocks[0]).toEqual({ kind: 'p', runs: [{ text: '导语第一行\n第二行' }] });
    expect(blocks[2]).toMatchObject({ kind: 'li', level: 1, ordered: false });
    expect(blocks[4]).toMatchObject({ kind: 'li', ordered: true, number: 2 });
  });
});
