import * as Y from 'yjs';
import {
  LATEX_LIMITS,
  LATEX_MAIN_FILE,
  LATEX_YDOC,
  LatexAsset,
  YDOC_FIELD,
  latexFileKind,
} from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * LaTeX 工程文件在 Y.Doc 里的读写（结构见 @srh/shared LATEX_YDOC，服务端 latex/project.ts 同步维护）：
 * main.tex = Y.Text `source`；其余文本文件在 Y.Map `files`（值为 Y.Text）；图片在 Y.Map `assets`。
 * 纯函数，测试见 files.test.ts。
 */

export type ProjectFileKind = 'main' | 'text' | 'image';

export interface ProjectFile {
  name: string;
  kind: ProjectFileKind;
  /** 图片：项目文件 id */
  asset?: LatexAsset;
}

export function filesMap(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>(LATEX_YDOC.files);
}

export function assetsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(LATEX_YDOC.assets);
}

/** main.tex 在最前，其余文本文件按路径排序，最后是图片 */
export function listProjectFiles(doc: Y.Doc): ProjectFile[] {
  const texts: ProjectFile[] = [];
  filesMap(doc).forEach((v, name) => {
    if (v instanceof Y.Text && latexFileKind(name) === 'text') texts.push({ name, kind: 'text' });
  });
  const images: ProjectFile[] = [];
  assetsMap(doc).forEach((v, name) => {
    const parsed = LatexAsset.safeParse(v);
    if (parsed.success && latexFileKind(name) === 'image') {
      images.push({ name, kind: 'image', asset: parsed.data });
    }
  });
  const byName = (a: ProjectFile, b: ProjectFile) => a.name.localeCompare(b.name);
  return [{ name: LATEX_MAIN_FILE, kind: 'main' }, ...texts.sort(byName), ...images.sort(byName)];
}

/** 文件对应的 Y.Text（main.tex → source）；不存在或不是文本返回 null */
export function textOf(doc: Y.Doc, name: string): Y.Text | null {
  if (name === LATEX_MAIN_FILE) return doc.getText(YDOC_FIELD.latex);
  const v = filesMap(doc).get(name);
  return v instanceof Y.Text ? v : null;
}

/** 所有文本文件的当前内容（草稿预览读 .bib 用） */
export function textContents(doc: Y.Doc): Record<string, string> {
  const out: Record<string, string> = {
    [LATEX_MAIN_FILE]: doc.getText(YDOC_FIELD.latex).toString(),
  };
  filesMap(doc).forEach((v, name) => {
    if (v instanceof Y.Text) out[name] = v.toString();
  });
  return out;
}

export type FileNameCheck =
  { ok: true; name: string; kind: 'text' | 'image' } | { ok: false; error: string };

/** 规范化并检查新文件名（去掉开头的 ./ 和 /，反斜杠改成 /） */
export function checkFileName(
  doc: Y.Doc,
  raw: string,
  expect?: 'text' | 'image',
  renaming?: string,
): FileNameCheck {
  let name = raw.trim().replace(/\\/gu, '/');
  while (name.startsWith('./') || name.startsWith('/')) name = name.replace(/^\.?\//u, '');
  if (!name) return { ok: false, error: tr('文件名不能为空') };
  if (name === LATEX_MAIN_FILE) return { ok: false, error: tr('main.tex 是主文件，换个名字吧') };
  const kind = latexFileKind(name);
  if (kind === null || kind === 'main') {
    return {
      ok: false,
      error: tr(
        '文件名只能用字母、数字、_ - .，扩展名可以是 .bib .tex .sty .cls .bst .txt，图片 .png .jpg .pdf',
      ),
    };
  }
  if (expect && kind !== expect) {
    return {
      ok: false,
      error:
        expect === 'text'
          ? tr('这里只能新建文本文件（如 .bib、.tex）')
          : tr('图片只支持 .png、.jpg、.pdf'),
    };
  }
  const exists =
    name !== renaming &&
    (filesMap(doc).has(name) || assetsMap(doc).has(name) || name.toLowerCase() === 'main.tex');
  if (exists) return { ok: false, error: tr('工程里已经有 {name} 了', { name }) };
  const count = filesMap(doc).size + assetsMap(doc).size;
  if (!renaming && count + 1 >= LATEX_LIMITS.files) {
    return { ok: false, error: tr('一个工程最多 {files} 个文件', { files: LATEX_LIMITS.files }) };
  }
  return { ok: true, name, kind };
}

/** 新建文本文件（返回规范化后的名字） */
export function createTextFile(doc: Y.Doc, name: string, content = ''): void {
  doc.transact(() => {
    const text = new Y.Text();
    if (content) text.insert(0, content);
    filesMap(doc).set(name, text);
  });
}

/** 改名：Y.Text 不能挪位置，只能复制内容到新的 Y.Text（协作者的编辑器会切到新文件） */
export function renameFile(doc: Y.Doc, from: string, to: string): void {
  if (from === to || from === LATEX_MAIN_FILE) return;
  doc.transact(() => {
    const files = filesMap(doc);
    const assets = assetsMap(doc);
    const t = files.get(from);
    if (t instanceof Y.Text) {
      const copy = new Y.Text();
      copy.insert(0, t.toString());
      files.delete(from);
      files.set(to, copy);
      return;
    }
    const a = assets.get(from);
    if (a !== undefined) {
      assets.delete(from);
      assets.set(to, a);
    }
  });
}

export function deleteFile(doc: Y.Doc, name: string): void {
  if (name === LATEX_MAIN_FILE) return;
  doc.transact(() => {
    filesMap(doc).delete(name);
    assetsMap(doc).delete(name);
  });
}

export function addAsset(doc: Y.Doc, name: string, asset: LatexAsset): void {
  assetsMap(doc).set(name, { fileId: asset.fileId, mime: asset.mime, size: asset.size });
}

/** 下一个可用的默认文件名：references.bib、references-2.bib… */
export function suggestName(doc: Y.Doc, base: string, ext: string): string {
  const taken = (n: string) => filesMap(doc).has(n) || assetsMap(doc).has(n);
  if (!taken(`${base}.${ext}`)) return `${base}.${ext}`;
  for (let i = 2; i < 100; i += 1) {
    if (!taken(`${base}-${i}.${ext}`)) return `${base}-${i}.${ext}`;
  }
  return `${base}-${Date.now().toString(36)}.${ext}`;
}

/** 当前选中的文件被删 / 改名后，切到哪个文件 */
export function resolveActive(files: ProjectFile[], active: string): string {
  const hit = files.find((f) => f.name === active);
  return hit && hit.kind !== 'image' ? active : LATEX_MAIN_FILE;
}

/** 编辑器用的语言模式 */
export function fileMode(name: string): 'latex' | 'bib' | 'plain' {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'bib') return 'bib';
  if (ext === 'tex' || ext === 'sty' || ext === 'cls') return 'latex';
  return 'plain';
}

export const BIB_TEMPLATE = tr(
  '% 参考文献：在正文里用 \\cite{key} 引用，\n% 并在 \\end{document} 前写 \\bibliographystyle{plain} 和 \\bibliography{references}\n\n@article{example2024,\n  author  = {Zhang, San and Li, Si},\n  title   = {An Example Article},\n  journal = {Journal of Examples},\n  year    = {2024}\n}\n',
);
