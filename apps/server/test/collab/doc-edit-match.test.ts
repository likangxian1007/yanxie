import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { ApiError, type DocumentContent, type DocumentEdit, type DocumentMeta } from '@srh/shared';
import { docSchema } from '../../src/modules/documents/pm-schema';
import type { PmMark, PmNode } from '../../src/modules/documents/markdown';
import { applyEdit, docJson, initContent, toMarkdown } from '../../src/modules/documents/ydoc';
import { setupCollabApp, type CollabTestApp } from './helpers';

/**
 * 第二轮终验：agent 按 read_document 读出的 markdown 改文档时
 *   - 附录 F：replace_section 的内容自带同名标题 → 出现两个同名小节，之后 replace_text 删不掉；
 *   - 演示前必修 #3 / 附录 C：重复的「## 9. 结果表（待跑）」、标题行匹配不到、「加一段」塞进上一段并继承宋体。
 * 文档结构按 docx 导入器写出的样子构造：段落由几个带 textStyle（宋体小四）的 run 组成。
 */

const SONG: PmMark = {
  type: 'textStyle',
  attrs: { color: null, fontFamily: '宋体, SimSun', fontSize: '12pt' },
};
const HEI: PmMark = {
  type: 'textStyle',
  attrs: { color: null, fontFamily: '黑体, SimHei', fontSize: '16pt' },
};
const run = (text: string, ...marks: PmMark[]): PmNode =>
  marks.length ? { type: 'text', text, marks } : { type: 'text', text };
const h = (level: number, ...content: PmNode[]): PmNode => ({
  type: 'heading',
  attrs: { level, spaceBefore: 12 },
  content,
});
const p = (...content: PmNode[]): PmNode => ({
  type: 'paragraph',
  attrs: { textIndent: 2 },
  content,
});

function fromJson(content: PmNode[]): Y.Doc {
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(
    docSchema(),
    { type: 'doc', content },
    doc.getXmlFragment('default'),
  );
  return doc;
}
const edit = (doc: Y.Doc, e: DocumentEdit) => doc.transact(() => applyEdit(doc, 'doc', e));
const md = (doc: Y.Doc) => toMarkdown(doc, 'doc');
const blocks = (doc: Y.Doc) => docJson(doc).content ?? [];
const count = (s: string, sub: string) => s.split(sub).length - 1;
/** 段落 / 标题里所有 XmlText 的文字（看 \n 有没有被塞进 run 里） */
const runTexts = (doc: Y.Doc, i: number) =>
  (doc.getXmlFragment('default').get(i) as Y.XmlElement)
    .toArray()
    .filter((c): c is Y.XmlText => c instanceof Y.XmlText)
    .map((t) =>
      (t.toDelta() as { insert: unknown }[])
        .map((d) => (typeof d.insert === 'string' ? d.insert : ''))
        .join(''),
    );

function thrown(fn: () => void): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('没有抛错');
}

const T3 = '三、本次复现选择（分析，不是论文结论）';

/** 调研笔记（docx 导入）：标题由黑体两个 run 组成，正文宋体小四 */
function notes(): Y.Doc {
  return fromJson([
    h(2, run('二、论文方法', HEI)),
    p(run('原文用 ', SONG), run('ResNet-50', SONG, { type: 'bold' }), run(' 做骨干。', SONG)),
    h(2, run('三、本次复现选择', HEI), run('（分析，不是论文结论）', HEI)),
    p(run('旧的选择说明。', SONG)),
    h(3, run('3.1 数据', HEI)),
    p(run('数据旧说明。', SONG)),
    h(2, run('四、风险', HEI)),
    p(run('显存不够。', SONG)),
  ]);
}

describe('replace_section：内容以同名标题开头时当作新标题（附录 F）', () => {
  it('不再多出一个空的同名小节；原标题的字体、段落格式保留；范围到下一个同级标题为止', () => {
    const doc = notes();
    edit(doc, {
      op: 'replace_section',
      heading: T3,
      markdown: `## ${T3}\n\n1. 用 ViT-S/16 替代\n2. 只跑 3 个种子`,
    });
    expect(md(doc)).toBe(
      [
        '## 二、论文方法',
        '原文用 **ResNet-50** 做骨干。',
        `## ${T3}`,
        '1. 用 ViT-S/16 替代\n2. 只跑 3 个种子',
        '## 四、风险',
        '显存不够。',
      ].join('\n\n'),
    );
    const title = blocks(doc)[2]!;
    expect(title.attrs).toMatchObject({ level: 2, spaceBefore: 12 });
    expect(title.content!.every((n) => n.marks?.[0]?.attrs?.fontFamily === '黑体, SimHei')).toBe(
      true,
    );
  });

  it('标题只差空白、全半角标点时同样识别为本节标题，保留原文', () => {
    const doc = notes();
    edit(doc, {
      op: 'replace_section',
      heading: '三、 本次复现选择 (分析,不是论文结论)',
      markdown: '## 三、本次复现选择 (分析, 不是论文结论)\n\n新的说明。',
    });
    const out = md(doc);
    expect(count(out, '三、本次复现选择')).toBe(1);
    expect(out).toContain(`## ${T3}\n\n新的说明。\n\n## 四、风险`);
  });

  it('以同级的另一个标题开头 = 改名（就地换文字，沿用原标题字体）', () => {
    const doc = notes();
    edit(doc, { op: 'replace_section', heading: T3, markdown: '## 三、复现方案\n\n新的说明。' });
    expect(md(doc)).toContain('## 三、复现方案\n\n新的说明。\n\n## 四、风险');
    expect(md(doc)).not.toContain('本次复现选择');
    expect(blocks(doc)[2]!.content![0]!.marks?.[0]?.attrs?.fontFamily).toBe('黑体, SimHei');
  });

  it('连续的空重复标题：replace_section 定位到最后一个并把空壳一起删掉', () => {
    const doc = fromJson([
      h(2, run('8. 方法', SONG)),
      p(run('方法正文。', SONG)),
      h(2, run('9. 结果表（待跑）', SONG)),
      h(2, run('9. 结果表（待跑）', SONG)),
      h(2, run('9. 结果表（待跑）', SONG)),
      p(run('旧表。', SONG)),
      h(2, run('10. 需要 小陈 补的信息', SONG)),
    ]);
    edit(doc, {
      op: 'replace_section',
      heading: '9. 结果表（待跑）',
      markdown: '## 9. 结果表（待跑）\n\n| 臂 | acc |\n| --- | --- |\n| A | 待跑 |',
    });
    expect(md(doc)).toBe(
      [
        '## 8. 方法',
        '方法正文。',
        '## 9. 结果表（待跑）',
        '| 臂 | acc |\n| --- | --- |\n| A | 待跑 |',
        '## 10. 需要 小陈 补的信息',
      ].join('\n\n'),
    );
  });

  it('insert_after_heading 的内容以本节标题开头时也去掉它', () => {
    const doc = notes();
    edit(doc, {
      op: 'insert_after_heading',
      heading: '四、风险',
      markdown: '## 四、风险\n\n时间不够。',
    });
    expect(md(doc).endsWith('## 四、风险\n\n显存不够。\n\n时间不够。')).toBe(true);
  });
});

describe('replace_text 匹配 read_document 读出的原文', () => {
  it('删掉空的重复标题：`## 标题` 或标题纯文字 → 空串，删除整个标题块（标题跨两个 run）', () => {
    const doc = fromJson([
      h(2, run('三、本次复现选择', HEI), run('（分析，不是论文结论）', HEI)),
      h(2, run('三、本次复现选择', HEI), run('（分析，不是论文结论）', HEI)),
      p(run('选择说明。', SONG)),
    ]);
    edit(doc, { op: 'replace_text', find: `## ${T3}`, replace: '' });
    expect(md(doc)).toBe(`## ${T3}\n\n选择说明。`);
    expect(blocks(doc).map((b) => b.type)).toEqual(['heading', 'paragraph']);

    const again = fromJson([
      h(2, run('三、本次复现选择', HEI), run('（分析，不是论文结论）', HEI)),
      p(run('x')),
    ]);
    edit(again, { op: 'replace_text', find: T3, replace: '' });
    expect(md(again)).toBe('x');
  });

  it('`## 标题` 只认标题块：正文里出现同样的字不受影响', () => {
    const doc = fromJson([
      p(run('BibTeX 见 7. BibTeX 一节。', SONG)),
      h(2, run('7. BibTeX', SONG)),
      h(2, run('7. BibTeX', SONG)),
      p(run('条目一。', SONG)),
    ]);
    edit(doc, { op: 'replace_text', find: '## 7. BibTeX', replace: '' });
    expect(md(doc)).toBe('BibTeX 见 7. BibTeX 一节。\n\n## 7. BibTeX\n\n条目一。');
  });

  it('跨格式标记、跨 run：find 写 markdown（**粗体**）也能命中，新文字沿用命中处的宋体', () => {
    const doc = notes();
    edit(doc, {
      op: 'replace_text',
      find: '原文用 **ResNet-50** 做骨干',
      replace: '原文用 ViT 做骨干',
    });
    expect(md(doc)).toContain('原文用 ViT 做骨干。');
    const para = blocks(doc)[1]!.content!;
    expect(para.map((n) => n.text).join('')).toBe('原文用 ViT 做骨干。');
    expect(para.every((n) => n.marks?.some((m) => m.attrs?.fontFamily === '宋体, SimSun'))).toBe(
      true,
    );
  });

  it('转义、NBSP、全角空格、中英文 / 标点前后空格的差异都能匹配', () => {
    const doc = fromJson([
      p(run('learning_rate 设为 1e-3，batch\u00a0size\u3000为 64。', SONG)),
      p(run('结果 （待跑）', SONG)),
    ]);
    edit(doc, {
      op: 'replace_text',
      find: 'learning\\_rate设为1e-3 ，batch size为64',
      replace: 'learning_rate 设为 3e-4，batch size 为 128',
    });
    edit(doc, { op: 'replace_text', find: '结果（待跑）', replace: '结果（已跑）' });
    expect(md(doc)).toBe('learning_rate 设为 3e-4，batch size 为 128。\n\n结果（已跑）');
  });

  it('跨标题的重复块（D1 的 4 个「## 9. 结果表（待跑）」）合并成一个，表格保留', () => {
    const doc = mk(
      [
        '## 8',
        '## 9. 结果表（待跑）',
        '## 9. 结果表（待跑）',
        '## 9. 结果表（待跑）',
        '## 9. 结果表（待跑）',
        '| 臂 | acc |\n| --- | --- |\n| A | 待跑 |',
        '## 10',
      ].join('\n\n'),
    );
    // agent 写的 find 和原文差一个空格、全角括号写成半角
    edit(doc, {
      op: 'replace_text',
      find: '## 9.结果表(待跑)\n\n## 9. 结果表（待跑）\n\n## 9. 结果表（待跑）\n\n## 9. 结果表（待跑）',
      replace: '## 9. 结果表（待跑）',
    });
    expect(md(doc)).toBe(
      '## 8\n\n## 9. 结果表（待跑）\n\n| 臂 | acc |\n| --- | --- |\n| A | 待跑 |\n\n## 10',
    );
  });

  it('整节原文（含列表、表格、图片）→ 空串：整节删掉，不留空段落', () => {
    const doc = mk(
      [
        '## 甲',
        '甲正文',
        '## 7. BibTeX',
        '- 条目 **一**',
        '- 条目二',
        '| a | b |\n| --- | --- |\n| 1 | 2 |',
        '![图](https://example.com/a.png)',
        '## 乙',
        '乙正文',
      ].join('\n\n'),
    );
    const section = md(doc).slice(md(doc).indexOf('## 7. BibTeX'), md(doc).indexOf('## 乙')).trim();
    edit(doc, { op: 'replace_text', find: section, replace: '' });
    expect(md(doc)).toBe('## 甲\n\n甲正文\n\n## 乙\n\n乙正文');
  });

  it('列表里的一项：`- 条目` → 空串删掉这一项', () => {
    const doc = mk('- 第一项\n- 第二项\n- 第三项');
    edit(doc, { op: 'replace_text', find: '- 第二项', replace: '' });
    expect(md(doc)).toBe('- 第一项\n- 第三项');
  });

  it('occurrence 与 all', () => {
    const doc = mk('## 小节\n\n甲。\n\n## 小节\n\n甲。');
    edit(doc, { op: 'replace_text', find: '## 小节', replace: '', occurrence: 2 });
    expect(md(doc)).toBe('## 小节\n\n甲。\n\n甲。');
    edit(doc, { op: 'replace_text', find: '甲。', replace: '乙。\n\n丙。', all: true });
    expect(md(doc)).toBe('## 小节\n\n乙。\n\n丙。\n\n乙。\n\n丙。');
    const e = thrown(() =>
      edit(doc, { op: 'replace_text', find: '乙。', replace: 'x', occurrence: 3 }),
    );
    expect(e.code).toBe('not_found');
    expect(e.message).toContain('只出现了 2 处');
  });

  it('找不到时给出最接近的原文（候选可以直接拿来当 find）', () => {
    const doc = mk(
      '## 9. 结果表（待跑）\n\n| 臂 | acc |\n| --- | --- |\n| A | 待跑 |\n\n## 10. 需要小陈补的信息\n\n数据路径。',
    );
    const e = thrown(() =>
      edit(doc, { op: 'replace_text', find: '## 9. 结果表（已跑完）', replace: '' }),
    );
    expect(e.code).toBe('not_found');
    const candidates = (e.details?.candidates ?? []) as string[];
    expect(candidates[0]).toBe('## 9. 结果表（待跑）');
    expect(e.message).toContain('最接近的原文：「## 9. 结果表（待跑）」');
    edit(doc, { op: 'replace_text', find: candidates[0]!, replace: '## 9. 结果表' });
    expect(md(doc).startsWith('## 9. 结果表\n\n| 臂')).toBe(true);
  });
});

describe('「加一段」：新段落是独立的块、正文默认样式（附录 C）', () => {
  /** 「4 结论与计划」一节，正文段落以宋体小四的 run 结尾 */
  function conclusion(): Y.Doc {
    return fromJson([
      h(2, run('4 结论与计划', HEI)),
      p(
        run('结论如上，', SONG),
        run('宋体小四', { ...SONG, attrs: { ...SONG.attrs, color: '#333333' } }),
      ),
    ]);
  }

  it('在段末补一段：原段落文字里没有 \\n，新段落没有字体标记', () => {
    const doc = conclusion();
    edit(doc, {
      op: 'replace_text',
      find: '宋体小四',
      replace: '宋体小四\n\n下一步计划：补消融实验。',
    });
    expect(blocks(doc).map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(runTexts(doc, 1).join('')).toBe('结论如上，宋体小四');
    expect(runTexts(doc, 1).some((t) => t.includes('\n'))).toBe(false);
    const [, kept, added] = blocks(doc);
    expect(kept!.attrs).toMatchObject({ textIndent: 2 });
    expect(kept!.content!.every((n) => n.marks?.[0]?.attrs?.fontFamily === '宋体, SimSun')).toBe(
      true,
    );
    expect(added!.content).toEqual([{ type: 'text', text: '下一步计划：补消融实验。' }]);
    expect(added!.attrs?.textIndent ?? null).toBeNull();
    expect(md(doc)).toBe('## 4 结论与计划\n\n结论如上，宋体小四\n\n下一步计划：补消融实验。');
  });

  it('在段中间拆开：后半句仍是宋体，接在新段落后面', () => {
    const doc = conclusion();
    edit(doc, { op: 'replace_text', find: '结论如上，', replace: '结论如上。\n\n插入的一段。' });
    expect(md(doc)).toBe('## 4 结论与计划\n\n结论如上。\n\n插入的一段。宋体小四');
    const added = blocks(doc)[2]!.content!;
    expect(added[0]).toEqual({ type: 'text', text: '插入的一段。' });
    expect(added[1]!.marks?.[0]?.attrs?.fontFamily).toBe('宋体, SimSun');
  });

  it('replace 里的行内 markdown 成为真正的格式', () => {
    const doc = conclusion();
    edit(doc, { op: 'replace_text', find: '宋体小四', replace: '**宋体小四**' });
    const last = blocks(doc)[1]!.content!.at(-1)!;
    expect(last.text).toBe('宋体小四');
    expect(last.marks?.map((m) => m.type).sort()).toEqual(['bold', 'textStyle']);
  });
});

function mk(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  initContent(doc, 'doc', markdown, 't');
  return doc;
}

// ---------------------------------------------------------------- 经 REST（服务层）

const PID = 'prj_doc_edit_match';
const base = `/api/v1/projects/${PID}`;
let t: CollabTestApp;

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_a', '张三', 1);
  await t.seedProject(PID, 'usr_a');
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe('POST P/docs/:id/edit（docx 导入的文档）', () => {
  it('导入 → 用读出的原文删掉重复标题、加一段；找不到时 404 带 candidates；表格 / 幻灯片不受影响', async () => {
    const state = Y.encodeStateAsUpdate(
      fromJson([
        h(2, run('三、本次复现选择', HEI), run('（分析，不是论文结论）', HEI)),
        h(2, run('三、本次复现选择', HEI), run('（分析，不是论文结论）', HEI)),
        p(run('旧的选择说明，', SONG), run('宋体小四', SONG)),
      ]),
    );
    const imp = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/import?kind=doc&title=${encodeURIComponent('调研笔记')}`,
      headers: { ...t.as('usr_a'), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(state),
    });
    expect(imp.statusCode, imp.body).toBe(201);
    const id = imp.json<DocumentMeta>().id;
    const read = async () =>
      (
        await t.app.inject({
          method: 'GET',
          url: `${base}/docs/${id}/markdown`,
          headers: t.as('usr_a'),
        })
      ).json<DocumentContent>();
    const post = (payload: Record<string, unknown>, docId = id) =>
      t.app.inject({
        method: 'POST',
        url: `${base}/docs/${docId}/edit`,
        headers: t.as('usr_a'),
        payload,
      });

    const before = await read();
    const titleLine = before.markdown.split('\n')[0]!;
    expect(titleLine).toBe(`## ${T3}`);
    let res = await post({ op: 'replace_text', find: titleLine, replace: '' });
    expect(res.statusCode, res.body).toBe(200);
    res = await post({
      op: 'replace_text',
      find: '宋体小四',
      replace: '宋体小四\n\n下一步计划：补消融实验。',
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await read();
    expect(after.markdown).toBe(`## ${T3}\n\n旧的选择说明，宋体小四\n\n下一步计划：补消融实验。`);
    expect(after.outline).toEqual([{ heading: T3, level: 2 }]);

    res = await post({ op: 'replace_text', find: '下一步计划：补对比实验', replace: 'x' });
    expect(res.statusCode).toBe(404);
    const err = res.json<{ error: { message: string; details?: { candidates?: string[] } } }>()
      .error;
    expect(err.details?.candidates?.[0]).toBe('下一步计划：补消融实验。');

    // 同名操作在表格 / 幻灯片上照旧
    const sheet = await t.app.inject({
      method: 'POST',
      url: `${base}/docs`,
      headers: t.as('usr_a'),
      payload: { kind: 'sheet', markdown: 'a,b' },
    });
    res = await post(
      { op: 'replace_text', find: 'a', replace: 'b' },
      sheet.json<DocumentMeta>().id,
    );
    expect(res.statusCode).toBe(400);
    const slides = await t.app.inject({
      method: 'POST',
      url: `${base}/docs`,
      headers: t.as('usr_a'),
      payload: { kind: 'slides', markdown: '## 封面\n\n## 结果\n- 好' },
    });
    res = await post(
      { op: 'replace_text', find: '好', replace: '很好' },
      slides.json<DocumentMeta>().id,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ markdown: string }>().markdown).toContain('很好');
  });
});

describe('标题级别沿用原文（agent 把一级标题写成 ##）', () => {
  const base = () =>
    fromJson([
      h(1, run('1 研究背景', HEI)),
      p(run('背景正文。', SONG)),
      h(1, run('2 研究方法', HEI)),
      p(run('旧方法。', SONG)),
      h(1, run('3 实验结果', HEI)),
      p(run('旧结果。', SONG)),
    ]);
  const levels = (doc: Y.Doc) =>
    blocks(doc)
      .filter((b) => b.type === 'heading')
      .map(
        (b) => `${String(b.attrs?.level)}:${(b.content ?? []).map((c) => c.text ?? '').join('')}`,
      );

  it('replace_section 以 ## 同名标题开头：保留 H1，子标题按差值平移', () => {
    const doc = base();
    edit(doc, {
      op: 'replace_section',
      heading: '2 研究方法',
      markdown: '## 2 研究方法\n\n新方法。\n\n### 2.1 数据\n\n数据说明。',
    });
    expect(levels(doc)).toEqual(['1:1 研究背景', '1:2 研究方法', '2:2.1 数据', '1:3 实验结果']);
    expect(count(md(doc), '2 研究方法')).toBe(1);
  });

  it('replace_text 用 ## 匹配并替换一级标题：保留 H1', () => {
    const doc = base();
    edit(doc, { op: 'replace_text', find: '## 3 实验结果', replace: '## 3 实验结果与分析' });
    expect(levels(doc)).toEqual(['1:1 研究背景', '1:2 研究方法', '1:3 实验结果与分析']);
  });

  it('insert_after_heading 以 ## 同名标题开头：子标题按差值平移', () => {
    const doc = base();
    edit(doc, {
      op: 'insert_after_heading',
      heading: '1 研究背景',
      markdown: '## 1 研究背景\n\n### 1.1 现状\n\n补充。',
    });
    expect(levels(doc)).toEqual(['1:1 研究背景', '2:1.1 现状', '1:2 研究方法', '1:3 实验结果']);
  });
});
