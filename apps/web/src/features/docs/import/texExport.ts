import { zipSync, type Zippable } from 'fflate';
import * as Y from 'yjs';
import { LATEX_MAIN_FILE, LATEX_YDOC, LatexAsset, YDOC_FIELD, latexFileKind } from '@srh/shared';

/**
 * LaTeX 工程打包成 .zip（main.tex + 其余文本文件 + 图片），目录结构与编译时一致，
 * 下载后可以直接在本地 / Overleaf 编译，也可以原样再导入（见 tex.ts）。
 */

export interface LatexZipResult {
  zip: Uint8Array;
  /** 取不到的图片（已从项目文件里删掉等） */
  missing: string[];
  fileCount: number;
}

const enc = new TextEncoder();

export async function buildLatexZip(
  doc: Y.Doc,
  fetchAsset: (fileId: string) => Promise<Uint8Array>,
): Promise<LatexZipResult> {
  const entries: Zippable = {
    [LATEX_MAIN_FILE]: enc.encode(doc.getText(YDOC_FIELD.latex).toString()),
  };
  doc.getMap<unknown>(LATEX_YDOC.files).forEach((value, name) => {
    if (latexFileKind(name) !== 'text') return;
    const text =
      value instanceof Y.Text ? value.toString() : typeof value === 'string' ? value : '';
    entries[name] = enc.encode(text);
  });
  const assets: { name: string; fileId: string }[] = [];
  doc.getMap<unknown>(LATEX_YDOC.assets).forEach((value, name) => {
    const parsed = LatexAsset.safeParse(value);
    if (parsed.success && latexFileKind(name) === 'image') {
      assets.push({ name, fileId: parsed.data.fileId });
    }
  });
  const missing: string[] = [];
  await Promise.all(
    assets.map(async (a) => {
      try {
        // 图片本身已压缩，不再压
        entries[a.name] = [await fetchAsset(a.fileId), { level: 0 }];
      } catch {
        missing.push(a.name);
      }
    }),
  );
  const zip = zipSync(entries, { level: 6 });
  return { zip, missing: missing.sort(), fileCount: Object.keys(entries).length };
}
