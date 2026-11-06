import { generateJSON, getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import DOMPurify from 'dompurify';
import { YDOC_FIELD } from '@srh/shared';
import type * as Y from 'yjs';
import { contentExtensions } from '../editors/rich/extensions';
import { markdownToHtml } from '../editors/rich/lib/markdown';
import { decodeText } from './text';
import { ImportError, type ImportResult } from './types';
import { tr } from '@/lib/i18n';

/**
 * Markdown / 纯文本 / HTML → 富文本：沿用编辑器自己的转换路径
 * （markdownToHtml = AI 插入用的同一套 marked + 公式 + 任务列表规则），
 * 再按富文本 schema（contentExtensions，与服务端 pm-schema 一致）解析成 ProseMirror JSON，
 * 写进 Y.XmlFragment 'default'。schema 里没有的结构按 Tiptap 的规则降级，不会写出非法节点。
 */

export const MARKUP_TEXT_LIMIT = 2_000_000;

function escapeHtml(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** 纯文本：空行分段，段内换行保留成 <br> */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .split(/\n{2,}/u)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/gu, '<br>')}</p>`)
    .join('');
}

/** 外来 HTML：只取 body，去掉脚本、样式、表单、嵌入 */
export function sanitizeImportedHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'link'],
    FORBID_ATTR: ['style', 'class', 'id'],
    WHOLE_DOCUMENT: false,
  });
  return typeof clean === 'string' ? clean : String(clean);
}

/** <title> 或第一个 <h1> */
function htmlTitle(html: string): string {
  const m =
    /<title[^>]*>([^<]{1,200})<\/title>/iu.exec(html) ??
    /<h1[^>]*>([\s\S]{1,400}?)<\/h1>/iu.exec(html);
  return m ? m[1]!.replace(/<[^>]+>/gu, '').trim() : '';
}

function markdownTitle(md: string): string {
  const m = /^#\s+(.+)$/mu.exec(md);
  return m ? m[1]!.trim() : '';
}

/** 把 HTML 写进富文本 Y.Doc（要求 fragment 为空） */
export function writeHtmlToRichDoc(html: string, ydoc: Y.Doc): void {
  const extensions = contentExtensions();
  const schema = getSchema(extensions);
  const json = generateJSON(html || '<p></p>', extensions);
  const fragment = ydoc.getXmlFragment(YDOC_FIELD.doc);
  ydoc.transact(() => {
    prosemirrorJSONToYXmlFragment(schema, json, fragment);
  });
}

async function readText(file: File): Promise<string> {
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  if (text.length > MARKUP_TEXT_LIMIT) {
    throw new ImportError(tr('文件太长了，一篇文档最多 200 万字，可以拆成几份再导入'));
  }
  return text;
}

export async function importMarkdown(file: File, ydoc: Y.Doc): Promise<ImportResult> {
  const md = await readText(file);
  writeHtmlToRichDoc(markdownToHtml(md).html, ydoc);
  return { title: markdownTitle(md) };
}

export async function importPlainText(file: File, ydoc: Y.Doc): Promise<ImportResult> {
  const text = await readText(file);
  writeHtmlToRichDoc(plainTextToHtml(text), ydoc);
  return { title: '' };
}

export async function importHtml(file: File, ydoc: Y.Doc): Promise<ImportResult> {
  const html = await readText(file);
  writeHtmlToRichDoc(sanitizeImportedHtml(html), ydoc);
  return { title: htmlTitle(html) };
}
