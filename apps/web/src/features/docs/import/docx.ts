import type * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { YDOC_FIELD } from '@srh/shared';
import { contentExtensions } from '../editors/rich/extensions';
import { docxToPm, type PmJSON } from '../editors/rich/word/docx-import';
import { DOC_PAGE_FIELD } from '../editors/rich/word/page';
import { ImportError, type ImportContext } from './types';
import { tr } from '@/lib/i18n';

/**
 * 导入 Word（.docx）为富文本文档（kind = doc）。
 *
 * 把内容写进**空的本地** Y.Doc 的 Y.XmlFragment `default`（以及页面设置 Y.Map `page`），
 * 外壳再把这个 Y.Doc 的状态发给服务端（POST P/docs/import），或由编辑器里的“导入 Word”合并进当前文档。
 * 图片通过 ctx.uploadFile 上传到项目文件；没有 ctx 时以 data URL 内嵌（只用于测试 / 预览）。
 * 映射规则见 editors/rich/word/docx-import.ts。
 */
let schema: Schema | null = null;
export function richSchema(): Schema {
  schema ??= getSchema(contentExtensions());
  return schema;
}

const BLOCKISH = new Set([
  'paragraph',
  'heading',
  'listItem',
  'tableRow',
  'codeBlock',
  'blockquote',
]);

function plainText(n: PmJSON): string {
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(plainText).join(n.type === 'tableRow' ? '\t' : '');
  return BLOCKISH.has(n.type) ? `${inner}\n` : inner;
}

/** 把导入结果规整成 schema 合法的结构（个别 Word 结构放不进时降级成纯文本段落，不让整篇导入失败） */
export function sanitizeDoc(json: PmJSON): { doc: PmJSON; degraded: number } {
  const s = richSchema();
  try {
    s.nodeFromJSON(json).check();
    return { doc: json, degraded: 0 };
  } catch {
    let degraded = 0;
    const blocks = (json.content ?? []).flatMap((block): PmJSON[] => {
      try {
        s.nodeFromJSON(block).check();
        return [block];
      } catch {
        degraded += 1;
        return plainText(block)
          .split('\n')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }));
      }
    });
    return {
      doc: { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] },
      degraded,
    };
  }
}

/** 解析 .docx 并写进 ydoc（必须是空文档）。返回建议的文档标题和没能完整导入的提示。 */
export async function importDocx(
  file: File,
  ydoc: Y.Doc,
  ctx?: ImportContext,
): Promise<{ title: string; warnings?: string[] }> {
  if (file.size === 0) throw new ImportError(tr('这个文件是空的'));
  let result: Awaited<ReturnType<typeof docxToPm>>;
  try {
    result = await docxToPm(file, ctx, file.name);
  } catch (e) {
    throw new ImportError(e instanceof Error ? e.message : tr('Word 文档解析失败'));
  }
  const { doc, degraded } = sanitizeDoc(result.doc);
  const frag = ydoc.getXmlFragment(YDOC_FIELD.doc);
  if (frag.length > 0) throw new ImportError(tr('只能导入到空文档里'));
  ydoc.transact(() => {
    prosemirrorJSONToYXmlFragment(richSchema(), doc, frag);
    const page = ydoc.getMap<unknown>(DOC_PAGE_FIELD);
    for (const [k, v] of Object.entries(result.page)) if (v !== undefined) page.set(k, v);
  });
  const warnings = [...new Set(result.warnings)];
  if (degraded > 0) warnings.push(tr('有 {degraded} 处复杂排版只保留了文字', { degraded }));
  return warnings.length ? { title: result.title, warnings } : { title: result.title };
}
