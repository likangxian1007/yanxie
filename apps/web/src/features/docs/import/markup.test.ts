import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SHEET_FIRST_ID, SHEET_YDOC, sheetTypeName } from '@srh/shared';
import { DOC_PAGE_FIELD } from '../editors/rich/word/page';
import { LEGACY_FORMATS, prepareWorkbook } from '../editors/sheet/model/migrate';
import { Workbook } from '../editors/sheet/model/workbook';
import {
  SLIDES_META_FIELD,
  getDeckMeta,
  insertSlides,
  normalizeDeck,
} from '../editors/slides/model/deck';
import { isBlankDoc, latexSourceIsTemplate } from './blank';
import { importHtml, importMarkdown, importPlainText, plainTextToHtml } from './markup';

function fragmentXml(doc: Y.Doc): string {
  return doc.getXmlFragment('default').toString();
}

describe('Markdown / 文本 / HTML → 富文本', () => {
  it('Markdown：标题、列表、任务、公式、表格进 XmlFragment', async () => {
    const md = [
      '# 组会纪要',
      '',
      '本周进展：**完成**基线实验，$E=mc^2$。',
      '',
      '- 第一点',
      '- 第二点',
      '',
      '待办：',
      '',
      '- [ ] 补实验',
      '- [x] 写周报',
      '',
      '| 模型 | 准确率 |',
      '| --- | --- |',
      '| GNN | 0.91 |',
    ].join('\n');
    const doc = new Y.Doc();
    const res = await importMarkdown(new File([md], '纪要.md'), doc);
    expect(res.title).toBe('组会纪要');
    const xml = fragmentXml(doc);
    // Word 式排版给标题加了 indent 等段落属性，这里只关心级别和文字
    expect(xml).toMatch(/<heading[^>]* level="1"[^>]*>组会纪要<\/heading>/u);
    expect(xml).toContain('<bold>完成</bold>');
    expect(xml).toContain('<inlinemath latex="E=mc^2">');
    expect(xml).toContain('<bulletlist>');
    expect(xml).toContain('<taskitem checked="true">');
    expect(xml).toContain('<table>');
  });

  it('纯文本：空行分段，段内换行保留', async () => {
    expect(plainTextToHtml('甲\n乙\n\n丙 <b>')).toBe('<p>甲<br>乙</p><p>丙 &lt;b&gt;</p>');
    const doc = new Y.Doc();
    await importPlainText(new File(['第一段\n\n第二段'], 'a.txt'), doc);
    expect(doc.getXmlFragment('default').length).toBe(2);
  });

  it('HTML：去掉脚本和样式，保留结构与标题', async () => {
    const html =
      '<html><head><title>网页标题</title><style>p{}</style></head><body><h2 onclick="x()">小节</h2><script>alert(1)</script><p>正文<a href="javascript:alert(1)">坏链接</a></p></body></html>';
    const doc = new Y.Doc();
    const res = await importHtml(new File([html], 'p.html'), doc);
    expect(res.title).toBe('网页标题');
    const xml = fragmentXml(doc);
    expect(xml).toMatch(/<heading[^>]* level="2"[^>]*>小节<\/heading>/u);
    expect(xml).not.toContain('alert');
    expect(xml).toContain('正文');
  });
});

describe('空白文档判断', () => {
  it('富文本：只有空段落算空白', () => {
    const doc = new Y.Doc();
    expect(isBlankDoc('doc', doc, '')).toBe(true);
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    expect(isBlankDoc('doc', doc, '')).toBe(true);
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('有字')]);
    doc.getXmlFragment('default').insert(1, [p]);
    expect(isBlankDoc('doc', doc, '')).toBe(false);
  });

  it('LaTeX：新建模板算空白，写了正文或加了文件就不算', () => {
    const tpl = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '',
      '\\title{未命名论文}',
      '\\author{}',
      '',
      '\\begin{document}',
      '\\maketitle',
      '',
      '\\section{Introduction}',
      '',
      '\\end{document}',
      '',
    ].join('\n');
    expect(latexSourceIsTemplate(tpl)).toBe(true);
    expect(
      latexSourceIsTemplate(
        tpl.replace('\\section{Introduction}', '\\section{Introduction}\n正文'),
      ),
    ).toBe(false);
    expect(latexSourceIsTemplate(tpl.replace('amsmath', 'ctex'))).toBe(false);
    const doc = new Y.Doc();
    doc.getText('source').insert(0, tpl);
    expect(isBlankDoc('latex', doc, '未命名论文')).toBe(true);
    const t = new Y.Text();
    doc.getMap<Y.Text>('files').set('references.bib', t);
    expect(isBlankDoc('latex', doc, '未命名论文')).toBe(false);
  });

  it('表格 / 幻灯片：初始结构算空白，有内容或不认识的字段都不算', () => {
    const sheet = new Y.Doc();
    sheet.getMap('sheet').set('rows', 50);
    sheet.getMap('sheet').set('cols', 12);
    expect(isBlankDoc('sheet', sheet, '')).toBe(true);
    sheet.getMap('cells').set('0:0', '1');
    expect(isBlankDoc('sheet', sheet, '')).toBe(false);

    const slides = new Y.Doc();
    const page = new Y.Map<unknown>();
    const title = new Y.Text();
    title.insert(0, '组会');
    page.set('id', 's1');
    page.set('layout', 'title');
    page.set('title', title);
    page.set('body', new Y.Text());
    slides.getArray('slides').push([page]);
    expect(isBlankDoc('slides', slides, '组会')).toBe(true);
    page.set('elements', new Y.Array());
    expect(isBlankDoc('slides', slides, '组会')).toBe(false);

    const extra = new Y.Doc();
    extra.getMap('sheets').set('s1', 'x');
    expect(isBlankDoc('sheet', extra, '')).toBe(false);
  });

  it('Word 文档：页面设置不算内容', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    doc.getMap(DOC_PAGE_FIELD).set('size', 'A4');
    doc.getMap(DOC_PAGE_FIELD).set('orientation', 'landscape');
    expect(isBlankDoc('doc', doc, '')).toBe(true);
    const h = new Y.XmlElement('heading');
    h.setAttribute('level', '1');
    h.insert(0, [new Y.XmlText('标题')]);
    doc.getXmlFragment('default').insert(1, [h]);
    expect(isBlankDoc('doc', doc, '')).toBe(false);
  });

  it('表格 v2 工作簿：新建 / 迁移后的空表算空白，写了单元格、格式、合并或多一张表就不算', () => {
    const fresh = new Y.Doc();
    prepareWorkbook(fresh);
    expect(fresh.getArray(SHEET_YDOC.order).length).toBe(1);
    expect(isBlankDoc('sheet', fresh, '')).toBe(true);
    // 调过列宽、冻结不算内容
    fresh.getMap(sheetTypeName(SHEET_FIRST_ID, 'colp')).set('c0', { w: 160 });
    fresh.getMap(sheetTypeName(SHEET_FIRST_ID, 'view')).set('frozenRows', 1);
    expect(isBlankDoc('sheet', fresh, '')).toBe(true);
    fresh.getMap(sheetTypeName(SHEET_FIRST_ID, 'cells')).set('r0:c0', '1');
    expect(isBlankDoc('sheet', fresh, '')).toBe(false);

    const styled = new Y.Doc();
    prepareWorkbook(styled);
    styled.getMap(sheetTypeName(SHEET_FIRST_ID, 'fmt')).set('r0:c0', 'st1');
    expect(isBlankDoc('sheet', styled, '')).toBe(false);

    const two = new Y.Doc();
    prepareWorkbook(two);
    const wb = new Workbook(two);
    wb.addSheet('test', { name: '第二张' });
    wb.destroy();
    expect(isBlankDoc('sheet', two, '')).toBe(false);

    // v1 空表迁移成 v2 后仍是空白（迁移会写 sheet.migrated）
    const legacy = new Y.Doc();
    legacy.getMap('sheet').set('rows', 50);
    legacy.getMap('sheet').set('cols', 12);
    prepareWorkbook(legacy);
    expect(legacy.getMap('sheet').get('migrated')).toBe(2);
    expect(isBlankDoc('sheet', legacy, '')).toBe(true);
  });

  it('幻灯片 v2：只有封面占位符（标题 = 文档标题）算空白', () => {
    const doc = new Y.Doc();
    insertSlides(doc, 0, [{ layout: 'title', content: { title: '组会汇报' } }], 'test');
    getDeckMeta(doc).set('theme', 'dark');
    expect(isBlankDoc('slides', doc, '组会汇报')).toBe(true);
    expect(isBlankDoc('slides', doc, '别的标题')).toBe(false);

    const sub = new Y.Doc();
    insertSlides(sub, 0, [{ layout: 'title', content: { subtitle: '张三' } }], 'test');
    expect(isBlankDoc('slides', sub, '')).toBe(false);

    const bg = new Y.Doc();
    insertSlides(bg, 0, [{ layout: 'title', bg: { type: 'color', color: '#000000' } }], 'test');
    expect(isBlankDoc('slides', bg, '')).toBe(false);

    const two = new Y.Doc();
    insertSlides(two, 0, [{ layout: 'title' }, { layout: 'content' }], 'test');
    expect(isBlankDoc('slides', two, '')).toBe(false);

    // 旧版（v1）封面页打开时迁移成 v2，结果仍是空白
    const legacy = new Y.Doc();
    const page = new Y.Map<unknown>();
    page.set('id', 's1');
    page.set('layout', 'title');
    page.set('title', new Y.Text('组会'));
    page.set('body', new Y.Text());
    page.set('notes', new Y.Text());
    legacy.getArray('slides').push([page]);
    expect(isBlankDoc('slides', legacy, '组会')).toBe(true);
    normalizeDeck(legacy);
    expect(page.get('v')).toBe(2);
    expect(isBlankDoc('slides', legacy, '组会')).toBe(true);
  });

  it('空白判断里写死的字段名与各编辑器模型一致', () => {
    expect(SLIDES_META_FIELD).toBe('slidesMeta');
    expect(LEGACY_FORMATS).toBe('formats');
  });
});
