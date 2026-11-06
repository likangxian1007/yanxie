import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import type { DocumentEdit } from '@srh/shared';
import { docSchema } from '../../src/modules/documents/pm-schema';
import { type PmNode } from '../../src/modules/documents/markdown';
import { applyEdit, docJson, initContent, toMarkdown } from '../../src/modules/documents/ydoc';

/**
 * 第二轮终验 #3：agent 照着 read_document 读出的 markdown 改文档时，
 * 标题行、跨段落的原文要能匹配；能删掉多余的（重复的）小节；
 * 「加一段」要成为独立段落，不能把换行塞进上一段的文字里。
 */
function mk(md: string) {
  const doc = new Y.Doc();
  initContent(doc, 'doc', md, 't');
  return doc;
}
const edit = (doc: Y.Doc, e: DocumentEdit) => doc.transact(() => applyEdit(doc, 'doc', e));
const md = (doc: Y.Doc) => toMarkdown(doc, 'doc');
const count = (s: string, sub: string) => s.split(sub).length - 1;

const DUP = [
  '# 计划',
  '## 8. 方法',
  '方法正文。',
  '## 9. 结果表（待跑）',
  '## 9. 结果表（待跑）',
  '## 9. 结果表（待跑）',
  '| 臂 | acc |\n| --- | --- |\n| A | 待跑 |',
  '## 10. 需要 小陈 补的信息',
  '数据路径。',
].join('\n\n');

describe('replace_text 能匹配标题行和跨段落原文', () => {
  it('把连续的重复标题合并成一个', () => {
    const doc = mk(DUP);
    edit(doc, {
      op: 'replace_text',
      find: '## 9. 结果表（待跑）\n\n## 9. 结果表（待跑）\n\n## 9. 结果表（待跑）',
      replace: '## 9. 结果表（待跑）',
    });
    const out = md(doc);
    expect(count(out, '## 9. 结果表（待跑）')).toBe(1);
    expect(out).toContain('| A | 待跑 |');
    expect(out).toContain('## 10. 需要 小陈 补的信息');
  });

  it('删除一个空标题（replace 为空串）', () => {
    const doc = mk('## 7. BibTeX\n\n## 7. BibTeX\n\n条目一。');
    edit(doc, { op: 'replace_text', find: '## 7. BibTeX', replace: '' });
    expect(count(md(doc), '## 7. BibTeX')).toBe(1);
    expect(md(doc)).toContain('条目一。');
  });

  it('occurrence 指定第几处', () => {
    const doc = mk('甲段。\n\n## 小节\n\n甲段。');
    edit(doc, { op: 'replace_text', find: '甲段。', replace: '乙段。', occurrence: 2 });
    expect(md(doc)).toBe('甲段。\n\n## 小节\n\n乙段。');
  });

  it('改标题文字本身', () => {
    const doc = mk('## 旧标题\n\n正文');
    edit(doc, { op: 'replace_text', find: '## 旧标题', replace: '## 新标题' });
    expect(md(doc)).toBe('## 新标题\n\n正文');
  });

  it('找不到时仍是 not_found', () => {
    const doc = mk('## 甲\n\n正文');
    expect(() => edit(doc, { op: 'replace_text', find: '## 乙', replace: '' })).toThrow(/找不到/u);
  });
});

describe('「加一段」成为独立段落，不继承上一段的字体', () => {
  it('replace 里有空行时，余下内容拆成新段落', () => {
    // 一段以宋体小四结尾（docx 导入常见）
    const json: PmNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '4 结论与计划' }] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '结论正文宋体小四',
              marks: [{ type: 'textStyle', attrs: { fontFamily: '宋体', fontSize: '12pt' } }],
            },
          ],
        },
      ],
    };
    const doc = new Y.Doc();
    prosemirrorJSONToYXmlFragment(docSchema(), json, doc.getXmlFragment('default'));
    edit(doc, {
      op: 'replace_text',
      find: '结论正文宋体小四',
      replace: '结论正文宋体小四\n\n下一步计划：补消融实验。',
    });
    const blocks = docJson(doc).content!;
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(blocks[1]!.content![0]!.text).toBe('结论正文宋体小四');
    expect(blocks[1]!.content![0]!.marks?.[0]?.attrs?.fontFamily).toBe('宋体');
    const added = blocks[2]!.content![0]!;
    expect(added.text).toBe('下一步计划：补消融实验。');
    expect(added.marks ?? []).toEqual([]);
  });
});

describe('replace_section / insert_after_heading 不会再写一遍自己的标题', () => {
  it('replace_section 的内容以本节标题开头时去掉它', () => {
    const doc = mk('## 三、选择\n\n旧\n\n## 四、其他\n\nx');
    edit(doc, { op: 'replace_section', heading: '三、选择', markdown: '## 三、选择\n\n1. 新内容' });
    const out = md(doc);
    expect(count(out, '## 三、选择')).toBe(1);
    expect(out).toContain('1. 新内容');
    expect(out).not.toContain('旧');
  });

  it('replace_section 内容为空 = 清空正文，保留标题', () => {
    const doc = mk('## 甲\n\n正文\n\n## 乙\n\ny');
    edit(doc, { op: 'replace_section', heading: '甲', markdown: '' });
    expect(md(doc)).toBe('## 甲\n\n## 乙\n\ny');
  });
});
