import * as Y from 'yjs';
import {
  LATEX_MAIN_FILE,
  LATEX_YDOC,
  LatexAsset,
  YDOC_FIELD,
  latexFileKind,
  type LatexProjectFile,
} from '@srh/shared';

/**
 * LaTeX 工程在 Y.Doc 里的读取（结构见 @srh/shared LATEX_YDOC）与编译前的安全检查。
 */

export interface LatexTextFile {
  name: string;
  content: string;
}

export interface LatexAssetRef extends LatexAsset {
  name: string;
}

export interface LatexProjectSnapshot {
  texts: LatexTextFile[];
  assets: LatexAssetRef[];
}

export function latexFilesMap(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>(LATEX_YDOC.files);
}

export function latexAssetsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(LATEX_YDOC.assets);
}

const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** 当前工程的全部文件（main.tex 在最前，其余按路径排序）；名字不合法的条目跳过 */
export function readLatexProject(doc: Y.Doc): LatexProjectSnapshot {
  const texts: LatexTextFile[] = [
    { name: LATEX_MAIN_FILE, content: doc.getText(YDOC_FIELD.latex).toString() },
  ];
  latexFilesMap(doc).forEach((value, name) => {
    if (latexFileKind(name) !== 'text') return;
    const content =
      value instanceof Y.Text ? value.toString() : typeof value === 'string' ? value : '';
    texts.push({ name, content });
  });
  const assets: LatexAssetRef[] = [];
  latexAssetsMap(doc).forEach((value, name) => {
    if (latexFileKind(name) !== 'image') return;
    const parsed = LatexAsset.safeParse(value);
    if (parsed.success) assets.push({ name, ...parsed.data });
  });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { texts: [texts[0]!, ...texts.slice(1).sort(byName)], assets: assets.sort(byName) };
}

/** 工程文件清单（给 markdown 读取 / agent 看）；只有 main.tex 时返回 null */
export function latexFileList(doc: Y.Doc): LatexProjectFile[] | null {
  const { texts, assets } = readLatexProject(doc);
  if (texts.length === 1 && assets.length === 0) return null;
  return [
    ...texts.map((t, i) => ({
      name: t.name,
      kind: i === 0 ? ('main' as const) : ('text' as const),
      size: utf8Bytes(t.content),
    })),
    ...assets.map((a) => ({ name: a.name, kind: 'image' as const, size: a.size })),
  ];
}

/** .bib 里的条目 key（给 agent 的文件清单附注用） */
export function bibKeys(bib: string, limit = 40): string[] {
  const keys: string[] = [];
  const re = /@([A-Za-z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/gu;
  for (let m = re.exec(bib); m && keys.length < limit; m = re.exec(bib)) {
    const type = m[1]!.toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    keys.push(m[2]!);
  }
  return keys;
}

/**
 * readDocument 里 latex 的 markdown 开头附一段注释，告诉读者（agent）工程里还有哪些文件。
 * 结构化编辑只改 main.tex，这几行注释不在 main.tex 里。
 */
export function latexFilesComment(doc: Y.Doc): string {
  const list = latexFileList(doc);
  if (!list) return '';
  const { texts } = readLatexProject(doc);
  const lines = ['% ---- 工程文件（研协附注，不属于 main.tex 源码；编辑只作用于 main.tex）----'];
  for (const f of list) {
    let note = '';
    if (f.kind === 'main') note = '（主文件，下面就是它的源码）';
    else if (f.kind === 'image') note = '（图片，可用 \\includegraphics 引用）';
    else if (f.name.toLowerCase().endsWith('.bib')) {
      const keys = bibKeys(texts.find((t) => t.name === f.name)?.content ?? '');
      note = keys.length ? `（参考文献：${keys.join(', ')}）` : '（参考文献，暂无条目）';
    }
    lines.push(`% ${f.name}${note}`);
  }
  lines.push('% ----');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- 缺失的参考文献库

export interface MissingBib {
  /** 引用它的工程文件 */
  file: string;
  line: number;
  /** BibTeX 要找的文件名（工程内路径，带 .bib） */
  name: string;
  /** 源码里的写法，例如 \bibliography{refs} */
  text: string;
}

function normBibName(raw: string): string | null {
  let p = raw.trim().replace(/\\/gu, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (!p) return null;
  return p.toLowerCase().endsWith('.bib') ? p : `${p}.bib`;
}

/**
 * \bibliography{a,b} / \addbibresource{x.bib} 引用了、但工程里没有的 .bib。
 * BibTeX 找不到库时 tectonic 只给一句 “errors were ignored”，PDF 照样生成（引用全是 [?]），
 * 很容易被当成编译成功，所以编译前单独查一遍，在日志里写清楚。
 */
export function findMissingBibs(texts: LatexTextFile[]): MissingBib[] {
  const have = new Set(texts.map((t) => t.name));
  const out: MissingBib[] = [];
  const seen = new Set<string>();
  const re = /\\(bibliography|addbibresource)(?![A-Za-z@])\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/gu;
  for (const file of texts) {
    if (!/\.(?:tex|ltx)$/iu.test(file.name)) continue;
    const lines = file.content.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripComments(lines[i]!);
      re.lastIndex = 0;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        const names = m[1] === 'bibliography' ? m[2]!.split(',') : [m[2]!];
        for (const raw of names) {
          const name = normBibName(raw);
          if (!name || have.has(name) || seen.has(name)) continue;
          seen.add(name);
          out.push({ file: file.name, line: i + 1, name, text: m[0] });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 安全检查

/** 带文件路径参数的命令（参数里不允许绝对路径和 ..） */
const PATH_COMMANDS = [
  'input',
  'include',
  'includeonly',
  'InputIfFileExists',
  'IfFileExists',
  'includegraphics',
  'includepdf',
  'includesvg',
  'lstinputlisting',
  'verbatiminput',
  'VerbatimInput',
  'inputminted',
  'bibliography',
  'addbibresource',
  'bibliographystyle',
  'import',
  'subimport',
  'inputfrom',
  'subfile',
  'usepackage',
  'RequirePackage',
  'documentclass',
  'LoadClass',
  'graphicspath',
  'openin',
  'openout',
  'read',
  'pdfximage',
  'XeTeXpicfile',
  'XeTeXpdffile',
];

const ABSOLUTE_OR_PARENT =
  /(?:^|[\s{},="'(])(?:\/|~[/\\]|[A-Za-z]:[/\\]|\\\\[A-Za-z0-9])|(?:^|[/\\{},\s=])\.\.(?:[/\\]|$)/u;

function stripComments(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

export interface UnsafeFinding {
  file: string;
  line: number;
  text: string;
}

/**
 * 找出引用工程外文件的写法（绝对路径、..、/proc、/etc…），编译前拒绝。
 * TeX 是图灵完备的，这只是第一道防线；生产环境请再配 LATEX_SANDBOX=bwrap 或容器隔离。
 */
export function findUnsafePath(texts: LatexTextFile[]): UnsafeFinding | null {
  const cmdRe = new RegExp(
    String.raw`\\(?:${PATH_COMMANDS.join('|')})(?![A-Za-z@])\*?\s*(?:\[[^\]]*\]\s*)*(?:\\[A-Za-z@]+\s*=?\s*|\d+\s*=?\s*)?(\{[^}]*\}|[^\s{}\\%]+)?`,
    'gu',
  );
  for (const file of texts) {
    if (file.name.toLowerCase().endsWith('.bib')) continue;
    const lines = file.content.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripComments(lines[i]!);
      if (!code.trim()) continue;
      if (/\/(?:proc|etc|sys|dev|root|home|var|usr|app|srv|opt|run|mnt)\//u.test(code)) {
        return { file: file.name, line: i + 1, text: code.trim().slice(0, 120) };
      }
      cmdRe.lastIndex = 0;
      for (let m = cmdRe.exec(code); m; m = cmdRe.exec(code)) {
        const arg = (m[1] ?? '').replace(/^\{|\}$/gu, '');
        if (arg && ABSOLUTE_OR_PARENT.test(` ${arg}`)) {
          return { file: file.name, line: i + 1, text: code.trim().slice(0, 120) };
        }
      }
    }
  }
  return null;
}
