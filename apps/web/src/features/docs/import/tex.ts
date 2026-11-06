import { unzipSync } from 'fflate';
import * as Y from 'yjs';
import { LATEX_LIMITS, LATEX_MAIN_FILE, LATEX_YDOC, YDOC_FIELD, latexFileKind } from '@srh/shared';
import { decodeText, fileBaseName, fileExt } from './text';
import { ImportError, type ImportContext, type ImportResult } from './types';
import { tr } from '@/lib/i18n';

/**
 * LaTeX 导入：
 * - 单个 .tex → 主文件（Y.Text `source`）；
 * - 工程 .zip（Overleaf / arXiv 源码包）→ 找出主文件（含 \documentclass 与 \begin{document}），
 *   以主文件所在目录为工程根：其余文本文件（.bib .tex .sty .cls .bst …）进 Y.Map `files`，
 *   图片（.png .jpg .pdf）经 ctx.uploadFile 传到项目文件夹后进 Y.Map `assets`。
 * 路径、数量、大小遵守 LATEX_LIMITS 与 latexFileKind（和编辑器、服务端编译一致）；
 * 放不进工程的文件跳过，并在 warnings 里告诉用户。
 */

/** 解压后总大小上限（防压缩炸弹） */
export const ZIP_MAX_UNCOMPRESSED = 200 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 2000;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
};

/** 编译产物、系统垃圾：静默跳过 */
const JUNK_EXTS = new Set([
  'aux',
  'log',
  'out',
  'toc',
  'lof',
  'lot',
  'fls',
  'fdb_latexmk',
  'synctex',
  'gz',
  'blg',
  'bbl',
  'bcf',
  'run',
  'nav',
  'snm',
  'vrb',
  'xdv',
  'dvi',
  'idx',
  'ilg',
  'ind',
]);

function stripTexComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '\\') {
          i += 1;
          continue;
        }
        if (line[i] === '%') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** 主文件得分：越高越像主文件；0 = 不是 */
export function mainFileScore(path: string, content: string): number {
  const code = stripTexComments(content);
  const hasClass = /\\documentclass\b/u.test(code);
  const hasBegin = /\\begin\s*\{document\}/u.test(code);
  if (!hasClass && !hasBegin) return 0;
  let score = (hasClass ? 4 : 0) + (hasBegin ? 4 : 0);
  const base = path.split('/').pop()!.toLowerCase();
  if (base === 'main.tex') score += 3;
  else if (/^(paper|thesis|article|manuscript|ms|root)\.tex$/u.test(base)) score += 1;
  score -= path.split('/').length - 1; // 越靠近根目录越像
  return Math.max(score, 1);
}

/** \title{…} 里的纯文本（取不到返回 ''） */
export function texTitle(src: string): string {
  const m = /\\title\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/u.exec(stripTexComments(src));
  if (!m) return '';
  return m[1]!
    .replace(/\\\\/gu, ' ')
    .replace(/\\[A-Za-z]+\*?\s*/gu, '')
    .replace(/[{}~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
}

function checkMainLength(text: string, name: string) {
  if (text.length > LATEX_LIMITS.textChars) {
    throw new ImportError(
      tr('{name} 太长了（超过 {value} 万字），可以拆成几个 \\input 文件', {
        name,
        value: LATEX_LIMITS.textChars / 10000,
      }),
    );
  }
}

async function importSingleTex(file: File, ydoc: Y.Doc): Promise<ImportResult> {
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  checkMainLength(text, file.name);
  ydoc.getText(YDOC_FIELD.latex).insert(0, text);
  const warnings: string[] = [];
  if (!/\\documentclass\b/u.test(stripTexComments(text))) {
    warnings.push(tr('文件里没有 \\documentclass，可能是章节文件而不是主文件'));
  }
  return { title: texTitle(text), warnings };
}

interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/** 规范化 zip 里的路径；目录、隐藏文件、__MACOSX 返回 null */
function cleanZipPath(raw: string): string | null {
  const path = raw.replace(/\\/gu, '/').replace(/^\.?\/+/u, '');
  if (!path || path.endsWith('/')) return null;
  const segs = path.split('/');
  if (segs.some((s) => s === '..' || s === '')) return null;
  if (segs[0] === '__MACOSX') return null;
  if (segs.some((s) => s.startsWith('.'))) return null; // .DS_Store、.git/…
  return path;
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  let total = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!cleanZipPath(f.name)) return false;
        count += 1;
        total += f.originalSize;
        if (count > ZIP_MAX_ENTRIES || total > ZIP_MAX_UNCOMPRESSED) {
          throw new ImportError(tr('压缩包解压后太大了（上限 200 MB、2000 个文件）'));
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError(tr('压缩包打不开，可能已损坏或不是 .zip 格式'));
  }
  return Object.entries(files)
    .map(([name, data]) => ({ path: cleanZipPath(name)!, data }))
    .filter((e) => e.path);
}

const isTexPath = (p: string) => fileExt(p) === 'tex';

/** 挑主文件：得分最高；同分取路径短的 */
export function pickMainFile(texts: { path: string; content: string }[]): string | null {
  let best: { path: string; score: number } | null = null;
  for (const t of texts) {
    if (!isTexPath(t.path)) continue;
    const score = mainFileScore(t.path, t.content);
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && t.path.length < best.path.length)) {
      best = { path: t.path, score };
    }
  }
  return best?.path ?? null;
}

/** 同时上传的图片数 */
const UPLOAD_CONCURRENCY = 3;

async function importZip(file: File, ydoc: Y.Doc, ctx?: ImportContext): Promise<ImportResult> {
  const entries = readZip(new Uint8Array(await file.arrayBuffer()));
  const decoded = new Map<string, string>();
  const textOf = (e: ZipEntry) => {
    let s = decoded.get(e.path);
    if (s === undefined) {
      s = decodeText(e.data);
      decoded.set(e.path, s);
    }
    return s;
  };
  const texEntries = entries.filter((e) => isTexPath(e.path));
  const mainPath = pickMainFile(texEntries.map((e) => ({ path: e.path, content: textOf(e) })));
  if (!mainPath) {
    throw new ImportError(
      tr('压缩包里没有找到 LaTeX 主文件（含 \\documentclass 和 \\begin{document} 的 .tex）'),
    );
  }
  // 以主文件所在目录为工程根（TeX 按主文件目录解析 \input 和图片路径）
  const root = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
  const mainText = textOf(entries.find((e) => e.path === mainPath)!);
  checkMainLength(mainText, mainPath);
  const mainStem = fileBaseName(mainPath);

  const skipped: string[] = [];
  const outside: string[] = [];
  const tooBig: string[] = [];
  const texts: { name: string; content: string }[] = [];
  const images: { name: string; data: Uint8Array; mime: string }[] = [];
  for (const e of entries) {
    if (e.path === mainPath) continue;
    if (root && !e.path.startsWith(root)) {
      outside.push(e.path);
      continue;
    }
    const name = e.path.slice(root.length);
    const ext = fileExt(name);
    if (JUNK_EXTS.has(ext) || name.endsWith('.synctex.gz')) continue;
    // 主文件编译出来的 PDF（main.pdf / paper.pdf）不是素材
    if (ext === 'pdf' && !name.includes('/') && fileBaseName(name) === mainStem) continue;
    const kind = name === LATEX_MAIN_FILE ? null : latexFileKind(name);
    if (kind === 'text') {
      const content = textOf(e);
      if (content.length > LATEX_LIMITS.textChars) tooBig.push(name);
      else texts.push({ name, content });
    } else if (kind === 'image') {
      if (e.data.byteLength > LATEX_LIMITS.assetBytes) tooBig.push(name);
      else images.push({ name, data: e.data, mime: IMAGE_MIME[ext] ?? 'application/octet-stream' });
    } else {
      skipped.push(name);
    }
  }

  // 数量上限（含 main.tex）：文本优先，其次图片
  const room = LATEX_LIMITS.files - 1;
  texts.sort((a, b) => a.name.localeCompare(b.name));
  images.sort((a, b) => a.name.localeCompare(b.name));
  const keptTexts = texts.slice(0, room);
  const keptImages = images.slice(0, Math.max(0, room - keptTexts.length));
  const dropped = [
    ...texts.slice(keptTexts.length).map((t) => t.name),
    ...images.slice(keptImages.length).map((i) => i.name),
  ];

  const warnings: string[] = [];
  const list = (names: string[]) =>
    `${names.slice(0, 5).join(tr('、'))}${names.length > 5 ? tr(' 等 {count} 个', { count: names.length }) : ''}`;

  // 图片：先上传，全部成功后再写 Y.Doc（失败直接中止，由外壳清理已上传的文件）
  const assets: { name: string; fileId: string; mime: string; size: number }[] = [];
  if (keptImages.length && !ctx) {
    warnings.push(tr('没有上传图片：{value}', { value: list(keptImages.map((i) => i.name)) }));
  } else if (ctx) {
    let next = 0;
    const worker = async () => {
      while (next < keptImages.length) {
        const img = keptImages[next]!;
        next += 1;
        const blob = new Blob([img.data.slice()], { type: img.mime });
        const uploaded = await ctx.uploadFile(blob, img.name);
        assets.push({ name: img.name, fileId: uploaded.id, mime: img.mime, size: blob.size });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, keptImages.length) }, worker),
    );
  }

  ydoc.transact(() => {
    ydoc.getText(YDOC_FIELD.latex).insert(0, mainText);
    const files = ydoc.getMap<Y.Text>(LATEX_YDOC.files);
    for (const t of keptTexts) {
      const text = new Y.Text();
      text.insert(0, t.content);
      files.set(t.name, text);
    }
    const assetMap = ydoc.getMap<unknown>(LATEX_YDOC.assets);
    for (const a of assets) {
      assetMap.set(a.name, { fileId: a.fileId, mime: a.mime, size: a.size });
    }
  });

  if (mainPath.split('/').pop() !== LATEX_MAIN_FILE) {
    warnings.push(tr('主文件 {mainPath} 已作为 main.tex 导入', { mainPath }));
  }
  if (skipped.length) {
    warnings.push(
      tr(
        '跳过了 {value}（文件名只能用字母、数字、_ - .，类型限 .tex .bib .sty .cls .bst .txt 和 .png .jpg .pdf 图片）',
        { value: list(skipped) },
      ),
    );
  }
  if (outside.length) warnings.push(tr('跳过了主文件目录以外的 {value}', { value: list(outside) }));
  if (tooBig.length) warnings.push(tr('跳过了太大的 {value}', { value: list(tooBig) }));
  if (dropped.length) {
    warnings.push(
      tr('一个工程最多 {files} 个文件，跳过了 {value}', {
        files: LATEX_LIMITS.files,
        value: list(dropped),
      }),
    );
  }
  return { title: texTitle(mainText), warnings };
}

export async function importTex(
  file: File,
  ydoc: Y.Doc,
  ctx?: ImportContext,
): Promise<ImportResult> {
  return fileExt(file.name) === 'zip' ? importZip(file, ydoc, ctx) : importSingleTex(file, ydoc);
}
