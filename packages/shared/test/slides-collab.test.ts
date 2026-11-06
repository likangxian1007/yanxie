import { describe, expect, it } from 'vitest';
import {
  markdownToSlideDoc,
  parseSlideDrafts,
  planSlide,
  planSlidesMarkdown,
  slideInlineNodes,
  type PlannedElement,
  type PlannedSlide,
  type SlidePmNode,
} from '../src';

/** 二轮终验附录 F 里 agent 实际传的 5 页组会 PPT（Marp 风格：`# 标题` + `---` 分页，第 4 页 7 行表） */
export const GROUP_MEETING_MARP = `# 小样本图像分类中的对比学习：调研与一次可自查的复现

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

备注：最后留 3 分钟给周老师提问。
`;

function texts(doc: SlidePmNode): string[] {
  const out: string[] = [];
  const visit = (n: SlidePmNode) => {
    if (n.type === 'paragraph')
      out.push(
        (n.content ?? []).map((c) => (c.type === 'hardBreak' ? '\n' : (c.text ?? ''))).join(''),
      );
    (n.content ?? []).forEach((c) => c.type !== 'text' && n.type !== 'paragraph' && visit(c));
  };
  visit(doc);
  return out;
}

function allText(el: PlannedElement): string[] {
  if (el.type === 'table') return el.cells.flat().map((c) => c.text);
  if (el.type === 'image') return [];
  return texts(el.doc).flatMap((t) => t.split('\n'));
}

export function assertPlayable(slides: PlannedSlide[], W = 960, H = 540) {
  for (const s of slides) {
    for (const el of s.elements) {
      expect(el.x).toBeGreaterThanOrEqual(0);
      expect(el.y).toBeGreaterThanOrEqual(0);
      expect(el.x + el.w).toBeLessThanOrEqual(W + 0.01);
      expect(el.y + el.h).toBeLessThanOrEqual(H + 0.01);
      for (const t of allText(el)) {
        expect(t).not.toMatch(/^\s*---\s*$/u);
        expect(t).not.toMatch(/^\s*\|/u);
        expect(t).not.toContain('**');
      }
    }
  }
}

describe('slides markdown：分页', () => {
  it('Marp 风格（# 标题 + --- 分页）得到 5 页，只有第 1 页是标题页', () => {
    const drafts = parseSlideDrafts(GROUP_MEETING_MARP);
    expect(drafts.map((d) => d.title)).toEqual([
      '小样本图像分类中的对比学习：调研与一次可自查的复现',
      '一、2023 年以来的三条路线',
      '二、我们的问题与设置',
      '三、结果（5-way 准确率 %，95% 置信区间）',
      '四、结论、局限与下一步',
    ]);
    expect(drafts.map((d) => d.layout)).toEqual([
      'title',
      'content',
      'content',
      'content',
      'content',
    ]);
    expect(drafts.every((d) => !/^\s*---\s*$/mu.test(d.body))).toBe(true);
    expect(drafts[3]!.notes).toBe('先讲 5-shot 这一列，再指出像素基线最高');
    expect(drafts[4]!.notes).toBe('最后留 3 分钟给周老师提问。');
    expect(drafts[4]!.body).not.toContain('备注');
  });

  it('只用 ## 分页、混用、front-matter 都不产生空页', () => {
    const only = parseSlideDrafts('# 封面\n张三\n\n## 背景\n- 一\n\n## 方法\n- 二');
    expect(only.map((d) => [d.title, d.layout])).toEqual([
      ['封面', 'title'],
      ['背景', 'content'],
      ['方法', 'content'],
    ]);
    const mixed = parseSlideDrafts(
      '---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# 封面\n张三\n\n---\n\n## 背景\n- 一\n\n## 方法\n- 二\n\n---\n\n---\n\n## 结论\n- 三\n',
    );
    expect(mixed.map((d) => d.title)).toEqual(['封面', '背景', '方法', '结论']);
    expect(mixed[0]!.body).toBe('张三');
    // Marp：每页都是 `# 标题` 时页内的 `##` 只是小标题
    const sub = parseSlideDrafts('# A\n- x\n\n---\n\n# B\n\n## 小节\n- y');
    expect(sub.map((d) => d.title)).toEqual(['A', 'B']);
    expect(sub[1]!.body).toContain('## 小节');
    // Slidev 每页 front-matter
    const slidev = parseSlideDrafts(
      '---\nlayout: cover\n---\n# 题目\n\n---\nlayout: section\n---\n# 第二部分\n',
    );
    expect(slidev.map((d) => [d.title, d.layout])).toEqual([
      ['题目', 'title'],
      ['第二部分', 'section'],
    ]);
    // 开头就是分页符：忽略
    expect(parseSlideDrafts('---\n\n# 只有一页\n- a')).toHaveLength(1);
  });

  it('代码块里的 --- 和 # 不分页；备注的几种写法', () => {
    const d = parseSlideDrafts('## 代码\n```yaml\n---\n# 注释\n```\nNote: 讲讲配置\n继续讲');
    expect(d).toHaveLength(1);
    expect(d[0]!.body).toContain('# 注释');
    expect(d[0]!.notes).toBe('讲讲配置\n继续讲');
    const c = parseSlideDrafts(
      '## A\n- x\n<!--\n多行\n备注\n-->\n<!-- _class: lead -->\n> 引用备注',
    );
    expect(c[0]!.notes).toBe('多行\n备注\n引用备注');
    expect(c[0]!.body).toBe('- x');
  });

  it('两栏只认 ||| / ::right::，显式 title 版式内容太多时改成 content', () => {
    expect(parseSlideDrafts('## 对比\n左\n|||\n右')[0]!.layout).toBe('two-column');
    expect(parseSlideDrafts('## 对比\n左\n::right::\n右')[0]!.layout).toBe('two-column');
    expect(
      parseSlideDrafts('## 结果\n<!-- layout: title -->\n\n| a | b |\n| - | - |\n| 1 | 2 |')[0]!
        .layout,
    ).toBe('content');
  });
});

describe('slides markdown：行内与列表', () => {
  it('行内标记不留字面符号', () => {
    const nodes = slideInlineNodes(
      '**粗** *斜* `code` ~~删~~ [链接](https://a.b) __也粗__ $a*b$ \\*星号',
    );
    expect(nodes.map((n) => n.text).join('')).toBe('粗 斜 code 删 链接 也粗 $a*b$ *星号');
    expect(nodes.find((n) => n.text === '粗')!.marks).toEqual([{ type: 'bold' }]);
    expect(nodes.find((n) => n.text === '链接')!.marks).toEqual([
      { type: 'link', attrs: { href: 'https://a.b' } },
    ]);
  });
  it('二级（2 格或 4 格缩进）列表保留层级', () => {
    for (const ind of ['  ', '    ']) {
      const doc = markdownToSlideDoc(`- 一\n${ind}- 一点一\n${ind}- 一点二\n- 二`);
      const list = doc.content![0]!;
      expect(list.type).toBe('bulletList');
      expect(list.content).toHaveLength(2);
      expect(list.content![0]!.content![1]!.type).toBe('bulletList');
      expect(list.content![0]!.content![1]!.content).toHaveLength(2);
    }
  });
});

describe('slides markdown：元素规划', () => {
  it('真实 5 页组会内容：表格是 table 元素，元素都在页面内，没有字面 --- / |', () => {
    const slides = planSlidesMarkdown(GROUP_MEETING_MARP);
    expect(slides).toHaveLength(5);
    expect(slides.map((s) => s.layout)).toEqual([
      'title',
      'content',
      'content',
      'content',
      'content',
    ]);
    assertPlayable(slides);
    const table = slides[3]!.elements.find((e) => e.type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(table.cells).toHaveLength(7);
    expect(table.cells.every((r) => r.length === 3)).toBe(true);
    expect(table.cells[0]!.map((c) => c.text)).toEqual(['方法', '1-shot', '5-shot']);
    expect(table.cells[0]!.every((c) => c.bold)).toBe(true);
    expect(table.cells[1]![2]).toEqual({ text: '89.04 [86.83, 91.45]', bold: true });
    expect(table.colW).toHaveLength(3);
    expect(table.rowH).toHaveLength(7);
    // 表格下面的说明文字在表格之后、页面之内
    const caption = slides[3]!.elements.find((e) => e.type === 'text' && e.ph === 'body')!;
    expect(caption.y).toBeGreaterThanOrEqual(table.y + table.h);
    // 二级列表保留
    const body = slides[2]!.elements.find((e) => e.type === 'text' && e.ph === 'body');
    expect(JSON.stringify(body)).toContain('"bulletList","content":[{"type":"listItem"');
  });

  it('很长的表拆成续页并重复表头，字号随行数缩小', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| 方法 ${i + 1} | ${i}.5 | **${i}.9** |`);
    const slides = planSlide({
      title: '大表',
      body: ['| 方法 | 1-shot | 5-shot |', '|:---|---:|:---:|', ...rows].join('\n'),
      notes: '讲重点',
      layout: 'content',
    });
    expect(slides.length).toBe(3);
    expect(slides.map((s) => s.title)).toEqual(['大表', '大表（续）', '大表（续）']);
    expect(slides[1]!.notes).toBe('');
    let total = 0;
    for (const s of slides) {
      expect(s.layout).toBe('title-only');
      const t = s.elements.find((e) => e.type === 'table');
      if (t?.type !== 'table') throw new Error('no table');
      expect(t.cells[0]!.map((c) => c.text)).toEqual(['方法', '1-shot', '5-shot']);
      expect(t.cells.length - 1).toBeLessThanOrEqual(12);
      expect(t.cells[1]![1]!.align).toBe('right');
      total += t.cells.length - 1;
    }
    expect(total).toBe(30);
    assertPlayable(slides);
    const small = planSlide({
      title: 't',
      body: '| a |\n|---|\n| 1 |',
      notes: '',
      layout: 'content',
    });
    const big = slides[0]!.elements.find((e) => e.type === 'table');
    const one = small[0]!.elements.find((e) => e.type === 'table');
    if (big?.type !== 'table' || one?.type !== 'table') throw new Error('no table');
    expect(big.style.fontSize).toBeLessThan(one.style.fontSize);
  });

  it('长正文缩小字号，再长就拆页', () => {
    const items = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `- 第 ${i + 1} 条：这是一条比较长的要点，用来测试正文字号自动缩小与拆页的逻辑。`,
      ).join('\n');
    const mid = planSlide({ title: '要点', body: items(14), notes: '', layout: 'content' });
    expect(mid).toHaveLength(1);
    const body = mid[0]!.elements.find((e) => e.type === 'text' && e.ph === 'body');
    if (body?.type !== 'text') throw new Error('no body');
    expect(body.style!.fontSize).toBeLessThan(22);
    const long = planSlide({ title: '要点', body: items(40), notes: '', layout: 'content' });
    expect(long.length).toBeGreaterThan(1);
    expect(long[1]!.title).toBe('要点（续）');
    assertPlayable(long);
  });

  it('图片：可访问的地址生成图片元素，相对路径生成占位说明', () => {
    const [ok] = planSlide({
      title: '图',
      body: '- 说明\n\n![柱状图](/api/v1/projects/p/files/f1)',
      notes: '',
      layout: 'content',
    });
    expect(ok!.layout).toBe('image-text');
    expect(ok!.elements.find((e) => e.type === 'image')).toMatchObject({
      src: '/api/v1/projects/p/files/f1',
      name: '柱状图',
      fit: 'contain',
    });
    const [miss] = planSlide({
      title: '图',
      body: '![](acc_bars.png)',
      notes: '',
      layout: 'content',
    });
    expect(miss!.elements.some((e) => e.type === 'image')).toBe(false);
    const ph = miss!.elements.find((e) => e.name === '图片占位');
    expect(JSON.stringify(ph)).toContain('图片未找到：acc_bars.png');
    assertPlayable([ok!, miss!]);
  });
});
