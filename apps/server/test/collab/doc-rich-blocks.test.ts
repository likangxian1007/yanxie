import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { markdownToPm, pmToMarkdown, type PmNode } from '../../src/modules/documents/markdown';
import { RICH_CUSTOM_NODES } from '../../src/modules/documents/pm-nodes';
import { docSchema } from '../../src/modules/documents/pm-schema';
import { applyEdit, docJson, initContent, toMarkdown } from '../../src/modules/documents/ydoc';

const IMG = '/api/v1/projects/prj_1/files/fil_01ABCDEF';

function types(json: PmNode): string[] {
  return (json.content ?? []).map((n) => n.type);
}

describe('富文本特殊块的 markdown 表示', () => {
  it('schema 里有图片 / 附件 / 内嵌文档 / 提及，属性与前端约定一致', () => {
    const schema = docSchema();
    for (const [name, attrs] of Object.entries(RICH_CUSTOM_NODES)) {
      const type = schema.nodes[name];
      expect(type, name).toBeDefined();
      expect(Object.keys(type!.spec.attrs ?? {}).sort()).toEqual([...attrs].sort());
    }
    expect(schema.nodes.mention!.isInline).toBe(true);
    expect(schema.nodes.image!.isBlock).toBe(true);
    expect(schema.nodes.docEmbed!.isAtom).toBe(true);
  });

  it('图片：独占一段 → image 块（地址、说明、图注、文件 id），导出回同一写法', () => {
    const json = markdownToPm(`前一段\n\n![模型结构](${IMG} "图 1：编码器")\n\n后一段`);
    expect(types(json)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(json.content![1]!.attrs).toEqual({
      src: IMG,
      alt: '模型结构',
      caption: '图 1：编码器',
      fileId: 'fil_01ABCDEF',
    });
    docSchema().nodeFromJSON(json).check();
    const md = pmToMarkdown(json);
    expect(md).toContain(`![模型结构](${IMG} "图 1：编码器")`);
    expect(types(markdownToPm(md))).toEqual(['paragraph', 'image', 'paragraph']);
  });

  it('agent 写的外链图片、段落中间的图片都变成图片块；标题里的图片退回成链接', () => {
    const json = markdownToPm(
      '曲线见 ![loss](https://example.com/a.png) 下降很快\n\n# 标题 ![x](https://e.com/x.png)',
    );
    expect(types(json)).toEqual(['paragraph', 'image', 'paragraph', 'heading']);
    expect(json.content![1]!.attrs).toMatchObject({
      src: 'https://example.com/a.png',
      fileId: null,
    });
    expect(json.content![3]!.content!.some((n) => n.type === 'image')).toBe(false);
    docSchema().nodeFromJSON(json).check();
    // 列表项、表格里的图片也合法
    const nested = markdownToPm(
      `- ![a](${IMG})\n\n| 图 | 说明 |\n| --- | --- |\n| ![b](${IMG}) | 结果 |`,
    );
    docSchema().nodeFromJSON(nested).check();
    expect(pmToMarkdown(nested)).toContain(`| ![b](${IMG}) | 结果 |`);
  });

  it('内嵌文档：[嵌入表格：标题](doc:id) ⇄ docEmbed；不是这种写法的 doc: 链接保持链接', () => {
    const json = markdownToPm(
      '[嵌入表格：实验数据](doc:doc_01SHEET)\n\n[嵌入幻灯片：组会](doc:doc_02)\n\n见 [另一篇](doc:doc_03)',
    );
    expect(types(json)).toEqual(['docEmbed', 'docEmbed', 'paragraph']);
    expect(json.content![0]!.attrs).toEqual({
      docId: 'doc_01SHEET',
      kind: 'sheet',
      title: '实验数据',
    });
    expect(json.content![1]!.attrs).toMatchObject({ kind: 'slides' });
    docSchema().nodeFromJSON(json).check();
    const md = pmToMarkdown(json);
    expect(md).toContain('[嵌入表格：实验数据](doc:doc_01SHEET)');
    expect(md).toContain('[嵌入幻灯片：组会](doc:doc_02)');
    expect(md).toContain('[另一篇](doc:doc_03)');
    // LaTeX / 文档
    const more = markdownToPm('[嵌入LaTeX 论文：论文](doc:d4)\n\n[嵌入文档：计划](doc:d5)');
    expect(more.content!.map((n) => n.attrs?.kind)).toEqual(['latex', 'doc']);
  });

  it('附件：[📎 文件名](地址) ⇄ fileAttachment', () => {
    const href = `${IMG}?download=1`;
    const json = markdownToPm(`[📎 结果.csv](${href})`);
    expect(json.content![0]).toEqual({
      type: 'fileAttachment',
      attrs: { href, fileId: 'fil_01ABCDEF', name: '结果.csv' },
    });
    expect(pmToMarkdown(json)).toBe(`[📎 结果.csv](${href})`);
  });

  it('提及：[@名字](mention:id) ⇄ 行内 mention 节点', () => {
    const json = markdownToPm('请 [@王老师](mention:usr_adv) 看一下');
    const para = json.content![0]!;
    expect(para.content!.map((n) => n.type)).toEqual(['text', 'mention', 'text']);
    expect(para.content![1]!.attrs).toEqual({ id: 'usr_adv', label: '王老师' });
    docSchema().nodeFromJSON(json).check();
    expect(pmToMarkdown(json)).toBe('请 [@王老师](mention:usr_adv) 看一下');
  });
});

describe('agent 结构化编辑与特殊块', () => {
  function seeded(markdown: string): Y.Doc {
    const doc = new Y.Doc();
    initContent(doc, 'doc', markdown, 't');
    return doc;
  }

  function topElements(doc: Y.Doc, name: string): Y.XmlElement[] {
    return doc
      .getXmlFragment('default')
      .toArray()
      .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === name);
  }

  it('读出 markdown 再原样 replace_all：内嵌块、图片仍在，宽度 / 高度等写不进 markdown 的属性保留', () => {
    const doc = seeded(
      `# 结果\n\n![曲线](${IMG})\n\n[嵌入表格：实验数据](doc:doc_S)\n\n请 [@李四](mention:usr_b) 补充`,
    );
    doc.transact(() => {
      topElements(doc, 'image')[0]!.setAttribute('width', 420 as unknown as string);
      topElements(doc, 'image')[0]!.setAttribute('align', 'left');
      topElements(doc, 'docEmbed')[0]!.setAttribute('height', 360 as unknown as string);
    });
    const md = toMarkdown(doc, 'doc');
    doc.transact(() => applyEdit(doc, 'doc', { op: 'replace_all', markdown: md }));
    const json = docJson(doc);
    expect(types(json)).toEqual(['heading', 'image', 'docEmbed', 'paragraph']);
    expect(json.content![1]!.attrs).toMatchObject({ width: 420, align: 'left', src: IMG });
    expect(json.content![2]!.attrs).toMatchObject({ docId: 'doc_S', height: 360 });
    expect(toMarkdown(doc, 'doc')).toBe(md);
  });

  it('replace_section 重写小节时带回同一嵌入的高度；replace_text 不动嵌入块', () => {
    const doc = seeded('# 数据\n\n说明\n\n[嵌入表格：实验数据](doc:doc_S)\n\n# 讨论\n\n待写');
    doc.transact(() =>
      topElements(doc, 'docEmbed')[0]!.setAttribute('height', 300 as unknown as string),
    );
    doc.transact(() =>
      applyEdit(doc, 'doc', {
        op: 'replace_section',
        heading: '数据',
        markdown: '新的说明\n\n[嵌入表格：实验数据](doc:doc_S)',
      }),
    );
    doc.transact(() =>
      applyEdit(doc, 'doc', { op: 'replace_text', find: '待写', replace: '已写' }),
    );
    const json = docJson(doc);
    expect(types(json)).toEqual(['heading', 'paragraph', 'docEmbed', 'heading', 'paragraph']);
    expect(json.content![2]!.attrs).toMatchObject({ docId: 'doc_S', height: 300 });
    expect(toMarkdown(doc, 'doc')).toContain('已写');
  });
});
