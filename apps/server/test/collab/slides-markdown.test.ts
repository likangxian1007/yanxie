import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyEdit, initContent, toMarkdown } from '../../src/modules/documents/ydoc';
import {
  fragmentPlainText,
  orderedSlides,
  SLIDES_META_FIELD,
} from '../../src/modules/documents/slides';

/**
 * 二轮终验「演示前必修 #1」回归：agent 用 create_document(kind=slides) 传 Marp 风格 markdown
 * （`# 标题` + `---` 分页，第 4 页 7 行结果表）生成的组会 PPT 必须能直接放映。
 */
const MARP_5 = `# 小样本图像分类中的对比学习：调研与一次可自查的复现

第 1 页 · 组会汇报

汇报人：林晓\u3000指导：周老师\u30002026 年 10 月

结论一句话：2023 年以来的路线大多依赖大骨干与大预训练；我们在 CPU 上做了最小可自查的复现，对比预训练明显胜过 episodic 训练，但没有胜过一个像素线性探针。

---

# 一、2023 年以来的三条路线

**路线 A：用对比损失优化原型**
- PrototypeFormer（Su et al., 2023, arXiv:2310.03517）：冻结 CLIP 特征，每类一个 prototype token 送进 transformer 得到原型与子原型，子原型之间构造正负对。报告 miniImageNet 5-way 5-shot 97.07%、1-shot 90.88%。

**路线 B：在局部描述子上做对比式选择**
- TCDSNet（Qiao et al., 2024, arXiv:2408.05953）：对每个 support 描述子算类内/类间平均相似度，softmax 后相除去 sigmoid 得对比判别分数，取 top-K。ResNet-12 上 miniImageNet 5-way 5-shot 85.12±0.42。

**路线 C：对比学习嵌入度量学习框架**
- Multi-level Relation Learning（Liu et al., 2023, arXiv:2311.01212）：跨域小样本高光谱，用对比学习学类级关系 + 交叉注意力学集合级关系。

共同前提：CLIP 级预训练特征或 ResNet-12 级骨干、miniImageNet 级数据。

---

# 二、我们的问题与设置

**问题**：把大骨干和大预训练都拿掉，只剩约 900 张 8×8 灰度图和一个 MLP，对比预训练还有没有收益？

- 数据：sklearn digits，1797 张 8×8 灰度图，10 类
- 划分：5 折轮换，每折 5 个 base 类（约 900 张）只做表征学习，另 5 个 novel 类只做评测
- 编码器：MLP 64→128→128（内核无 torch，编码器与损失、梯度全部 numpy 手写，已做数值梯度校验）
  - 对比预训练接 128→64 投影头，评测时丢弃
- 增强：平移与旋转用边缘填充；不做水平翻转（2/5、6/9 会改语义）
- 评测：5-way 1-shot / 5-shot，每类 15 张 query，100 episode，2 个 seed
- 六条臂：ProtoNet、SupCon、SimCLR、随机编码器（不训练）、像素原型、像素线性探针

---

# 三、结果（5-way 准确率 %，95% 置信区间）

| 方法 | 1-shot | 5-shot |
| --- | --- | --- |
| 像素线性探针 | 72.03 [69.40, 75.50] | **89.04** [86.83, 91.45] |
| 像素原型 | 71.79 [69.06, 75.54] | 87.82 [85.30, 90.85] |
| SupCon | **70.69** [68.89, 72.78] | 85.89 [84.31, 87.56] |
| SimCLR | 70.58 [68.15, 73.38] | 85.72 [83.86, 87.90] |
| 随机编码器（不训练） | 67.29 [64.72, 70.21] | 83.51 [80.64, 86.37] |
| ProtoNet | 59.93 [57.75, 61.92] | 74.95 [72.97, 76.81] |

柱状图与预训练损失曲线见实验记录里 notebook 的单元格输出（acc_bars.png、loss_curves.png）。

<!-- 先讲 5-shot 这一列，再指出像素基线最高 -->

---

# 四、结论、局限与下一步

**结论**

1. SupCon 比 ProtoNet 高 10.94 个百分点（5-shot），CI 不重叠；但 ProtoNet 甚至低于随机编码器，"训坏了"的可能性存在，这个差距不能全归给对比损失。
2. SupCon 与 SimCLR 无法区分（85.89 对 85.72，CI 大幅重叠）。
3. 两条像素基线都高于所有训练过的编码器。本设定下可测的收益主要来自"冻结表征 + 原型分类"这一评测方式。

**局限**
单一数据集、8×8 分辨率、MLP 不是卷积、2 个 seed、未做配对显著性检验；与 miniImageNet 上的报告数字不可比。

**下一步（请周老师定优先级）**

- 加卷积骨干或换成 CIFAR-FS 这类彩色小数据
- 把对比预训练拉到损失收敛，再比一次
- 增加 seed 并做配对检验
`;

type El = Y.Map<unknown>;

function elementsOf(page: Y.Map<unknown>): El[] {
  const els = page.get('elements') as Y.Map<El>;
  const z = (e: El) => String(e.get('z'));
  return [...els.values()].sort((a, b) => (z(a) < z(b) ? -1 : z(a) > z(b) ? 1 : 0));
}

function cellGrid(el: El): Array<Array<Y.Map<unknown>>> {
  return (
    (el.get('cells') as Y.Array<Y.Array<Y.Map<unknown>>>).toArray() as Y.Array<Y.Map<unknown>>[]
  ).map((r) => r.toArray());
}

function textsOf(el: El): string[] {
  if (el.get('type') === 'table')
    return cellGrid(el)
      .flat()
      .map((c) => (c.get('text') as Y.Text).toString());
  const t = el.get('text');
  return t instanceof Y.XmlFragment ? fragmentPlainText(t).split('\n') : [];
}

function deck(md: string) {
  const doc = new Y.Doc();
  initContent(doc, 'slides', md, '组会');
  return { doc, pages: orderedSlides(doc) };
}

/** 能直接放映：没有字面 `---` / `| … |` / `**`，元素都在画布里 */
function expectPlayable(doc: Y.Doc, pages: Y.Map<unknown>[]) {
  const meta = doc.getMap(SLIDES_META_FIELD);
  const W = Number(meta.get('w')) || 960;
  const H = Number(meta.get('h')) || 540;
  for (const p of pages) {
    expect(p.get('v')).toBe(2);
    for (const el of elementsOf(p)) {
      const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((k) => el.get(k) as number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x! + w!).toBeLessThanOrEqual(W + 0.01);
      expect(y! + h!).toBeLessThanOrEqual(H + 0.01);
      for (const t of textsOf(el)) {
        expect(t).not.toMatch(/^\s*-{3,}\s*$/u);
        expect(t).not.toMatch(/^\s*\|/u);
        expect(t).not.toContain('**');
        expect(t).not.toMatch(/^#{1,6}\s/u);
      }
    }
  }
}

function tableOf(page: Y.Map<unknown>): El | undefined {
  return elementsOf(page).find((e) => e.get('type') === 'table');
}

describe('slides：Marp 风格 markdown 生成能放映的 PPT', () => {
  it('5 页组会：页数、版式、表格元素、画布范围都对', () => {
    const { doc, pages } = deck(MARP_5);
    expect(pages).toHaveLength(5);
    expect(pages.map((p) => p.get('layout'))).toEqual([
      'title',
      'content',
      'content',
      'content',
      'content',
    ]);
    expectPlayable(doc, pages);

    // 每页的标题占位符
    const titles = pages.map((p) => {
      const t = elementsOf(p).find((e) => e.get('ph') === 'title')!;
      return fragmentPlainText(t.get('text') as Y.XmlFragment);
    });
    expect(titles[3]).toBe('三、结果（5-way 准确率 %，95% 置信区间）');

    // 第 4 页：真正的 table 元素，7 行 × 3 列，表头加粗，**89.04** 变成加粗单元格
    const table = tableOf(pages[3]!)!;
    expect(table).toBeDefined();
    const grid = cellGrid(table);
    expect(grid).toHaveLength(7);
    expect(grid.every((r) => r.length === 3)).toBe(true);
    expect(grid[0]!.map((c) => (c.get('text') as Y.Text).toString())).toEqual([
      '方法',
      '1-shot',
      '5-shot',
    ]);
    expect(grid[0]!.every((c) => c.get('bold') === true)).toBe(true);
    expect((grid[1]![2]!.get('text') as Y.Text).toString()).toBe('89.04 [86.83, 91.45]');
    expect(grid[1]![2]!.get('bold')).toBe(true);
    expect(table.get('header')).toBe(true);
    expect((table.get('colW') as number[]).length).toBe(3);
    expect((table.get('rowH') as number[]).length).toBe(7);
    expect((table.get('style') as { fontSize: number }).fontSize).toBeGreaterThanOrEqual(11);
    // 说明文字在表格下方
    const caption = elementsOf(pages[3]!).find((e) => e.get('ph') === 'body')!;
    expect(caption.get('y') as number).toBeGreaterThanOrEqual(
      (table.get('y') as number) + (table.get('h') as number),
    );
    // HTML 注释进了备注
    expect((pages[3]!.get('notes') as Y.Text).toString()).toBe(
      '先讲 5-shot 这一列，再指出像素基线最高',
    );

    // 第 3 页：二级列表保留层级
    const body = elementsOf(pages[2]!).find((e) => e.get('ph') === 'body')!;
    const lists = (body.get('text') as Y.XmlFragment)
      .toArray()
      .filter((n) => n instanceof Y.XmlElement && n.nodeName === 'bulletList') as Y.XmlElement[];
    const nested = lists[0]!
      .toArray()
      .some(
        (li) =>
          li instanceof Y.XmlElement &&
          li.toArray().some((c) => c instanceof Y.XmlElement && c.nodeName === 'bulletList'),
      );
    expect(nested).toBe(true);
  });

  it('toMarkdown 往返：表格写回 markdown 表格，再解析得到同样的页', () => {
    const { doc } = deck(MARP_5);
    const md = toMarkdown(doc, 'slides');
    expect(md).toContain('| 方法 | 1-shot | 5-shot |');
    expect(md).toContain('| 像素线性探针 | 72.03 [69.40, 75.50] | **89.04 [86.83, 91.45]** |');
    expect(md).toContain('  - 对比预训练接 128→64 投影头，评测时丢弃');
    expect(md).toContain('> 先讲 5-shot 这一列，再指出像素基线最高');
    const again = deck(md);
    expect(again.pages.map((p) => p.get('layout'))).toEqual([
      'title',
      'content',
      'content',
      'content',
      'content',
    ]);
    const g = cellGrid(tableOf(again.pages[3]!)!);
    expect(g).toHaveLength(7);
    expect(g[1]![2]!.get('bold')).toBe(true);
    expect(toMarkdown(again.doc, 'slides')).toBe(md);
    expectPlayable(again.doc, again.pages);
  });

  it('只用 ## 分页、混用 --- 与 ##、带 front-matter：页数对、没有空页', () => {
    const onlyH2 = deck(
      '## 组会汇报\n张三\n\n## 背景\n- 一\n- 二\n\n## 结果\n| 方法 | 准确率 |\n|---|---|\n| A | 1 |\n| B | 2 |\n\n## 谢谢',
    );
    expect(onlyH2.pages.map((p) => p.get('layout'))).toEqual([
      'title',
      'content',
      'title-only',
      'section',
    ]);
    expectPlayable(onlyH2.doc, onlyH2.pages);

    const mixed = deck(
      '# 封面\n副标题\n\n---\n\n## 背景\n- 一\n\n## 方法\n- 二\n\n---\n\n---\n\n## 结论\n- 三\n',
    );
    expect(mixed.pages).toHaveLength(4);
    expect(mixed.pages.map((p) => p.get('layout'))).toEqual([
      'title',
      'content',
      'content',
      'content',
    ]);
    expectPlayable(mixed.doc, mixed.pages);

    const fm = deck(`---\nmarp: true\ntheme: gaia\npaginate: true\n---\n\n${MARP_5}`);
    expect(fm.pages).toHaveLength(5);
    expect(toMarkdown(fm.doc, 'slides')).not.toContain('marp: true');
    expectPlayable(fm.doc, fm.pages);
  });

  it('以前错误往返留下的「每页 layout: title」写回去也能放映', () => {
    const buggy = MARP_5.replace(/^# (.+)$/gmu, '## $1\n\n<!-- layout: title -->');
    const { doc, pages } = deck(buggy);
    expect(pages.map((p) => p.get('layout'))).toEqual([
      'title',
      'content',
      'content',
      'content',
      'content',
    ]);
    expectPlayable(doc, pages);
  });

  it('长表拆成续页，长正文缩小字号或拆页，图片地址无效时放占位说明', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| 方法 ${i + 1} | ${60 + i}.1 |`).join('\n');
    const longItems = Array.from(
      { length: 30 },
      (_, i) => `- 第 ${i + 1} 条要点，内容足够长，长到一页放不下所有要点为止。`,
    ).join('\n');
    const { doc, pages } = deck(
      `## 大表\n| 方法 | 准确率 |\n|---|---|\n${rows}\n\n---\n\n## 要点\n${longItems}\n\n---\n\n## 图\n![柱状图](acc_bars.png)\n\n---\n\n## 线上图\n- 说明\n\n![曲线](https://example.com/a.png)`,
    );
    const titles = pages.map((p) => slideTitle(p));
    expect(titles.filter((t) => t === '大表（续）')).toHaveLength(1);
    expect(titles.filter((t) => t === '要点（续）').length).toBeGreaterThanOrEqual(1);
    const t1 = cellGrid(tableOf(pages[0]!)!);
    const t2 = cellGrid(tableOf(pages[1]!)!);
    expect(t1.length - 1 + t2.length - 1).toBe(20);
    expect((t2[0]![0]!.get('text') as Y.Text).toString()).toBe('方法');
    const fig = pages[titles.indexOf('图')]!;
    expect(elementsOf(fig).some((e) => e.get('type') === 'image')).toBe(false);
    expect(elementsOf(fig).flatMap(textsOf).join('\n')).toContain(
      '图片未找到：柱状图（acc_bars.png）',
    );
    const web = pages[titles.indexOf('线上图')]!;
    expect(web.get('layout')).toBe('image-text');
    expect(
      elementsOf(web)
        .find((e) => e.get('type') === 'image')!
        .get('src'),
    ).toBe('https://example.com/a.png');
    expectPlayable(doc, pages);
  });

  it('append_slides 直接传带表格的正文也生成 table 元素；两栏仍可用 ---（SlideInput）或 |||', () => {
    const doc = new Y.Doc();
    initContent(doc, 'slides', '# 封面', 'x');
    applyEdit(doc, 'slides', {
      op: 'append_slides',
      slides: [
        { title: '结果', body: '| a | b |\n| --- | --- |\n| 1 | **2** |' },
        { title: '对比', body: '左\n|||\n右' },
      ],
    });
    applyEdit(doc, 'slides', {
      op: 'append',
      markdown: '## 两栏\n<!-- layout: two-column -->\n左\n\n|||\n\n右',
    });
    const pages = orderedSlides(doc);
    expect(pages).toHaveLength(4);
    expect(tableOf(pages[1]!)).toBeDefined();
    expect(pages[3]!.get('layout')).toBe('two-column');
    expect(elementsOf(pages[3]!).filter((e) => e.get('ph') === 'body')).toHaveLength(2);
    expectPlayable(doc, pages);
  });
});

function slideTitle(p: Y.Map<unknown>): string {
  const t = elementsOf(p).find((e) => e.get('ph') === 'title');
  return t ? fragmentPlainText(t.get('text') as Y.XmlFragment) : '';
}
