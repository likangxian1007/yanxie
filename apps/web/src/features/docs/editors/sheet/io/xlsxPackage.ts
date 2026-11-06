import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import { tr } from '@/lib/i18n';

/**
 * .xlsx 包（OPC zip）的预处理，在交给 ExcelJS 之前做：
 *
 * 1. 认文件头：zip（真正的 .xlsx）/ CFB（加密的 .xlsx 或旧版 .xls）/ 其他，给出不误导的提示；
 * 2. 剥掉 DrawingML 绘图层：xl/drawings/*.xml（不含批注用的 .vml）、xl/charts/**、它们的 _rels，
 *    以及所有 rels 里指向它们的关系、[Content_Types].xml 里的 Override、工作表 XML 里的 <drawing r:id/>。
 *
 * 为什么整体剥 drawing 而不是只剥图表：ExcelJS 4.4.0 只认带 `xdr:` 前缀的 drawing XML，
 * openpyxl / WPS 等写出的无前缀 drawing 一律解析成 undefined，随后在 reconcile 里
 * `Cannot read properties of undefined (reading 'anchors')`——图片和图表都会触发。
 * 表格编辑器本身也不支持图片和图表，保留它们没有收益，所以整体剥掉，
 * 但先把图表（标题、引用的数据范围）、图片、形状数出来，交给调用方写进 warnings。
 */

export type SpreadsheetKind =
  /** zip 包，按 .xlsx 读 */
  | 'zip'
  /** CFB 容器里是 EncryptionInfo / EncryptedPackage：设置了打开密码的 .xlsx */
  | 'encrypted'
  /** CFB 容器里是 Workbook / Book 流：Excel 97-2003 的 .xls */
  | 'xls'
  /** 其他 CFB（例如改了扩展名的 .doc） */
  | 'cfb'
  | 'empty'
  | 'unknown';

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/** 在字节里找 UTF-16LE 编码的字符串（CFB 目录项的名字就是这么存的） */
function hasUtf16(bytes: Uint8Array, s: string): boolean {
  const pat = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i += 1) pat[i * 2] = s.charCodeAt(i);
  const first = pat[0];
  outer: for (let i = 0; i + pat.length <= bytes.length; i += 1) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < pat.length; j += 1) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

export function sniffSpreadsheet(bytes: Uint8Array): SpreadsheetKind {
  if (bytes.length === 0) return 'empty';
  // PK\3\4（普通 zip）或 PK\5\6（空 zip）
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) return 'zip';
  if (startsWith(bytes, CFB_MAGIC)) {
    if (hasUtf16(bytes, 'EncryptionInfo') || hasUtf16(bytes, 'EncryptedPackage'))
      return 'encrypted';
    if (hasUtf16(bytes, 'Workbook') || hasUtf16(bytes, 'Book')) return 'xls';
    return 'cfb';
  }
  return 'unknown';
}

/** 不是 zip 时给用户看的话（null = 是 zip，继续读） */
export function sniffMessage(kind: SpreadsheetKind): string | null {
  switch (kind) {
    case 'zip':
      return null;
    case 'encrypted':
      return tr(
        '这个文件设置了打开密码，没法导入。请在 Excel 里打开它，到「文件 → 信息 → 保护工作簿 → 用密码进行加密」清空密码并保存后再导入',
      );
    case 'xls':
      return tr(
        '这是旧版 Excel 97-2003（.xls）格式的文件，暂不支持。请在 Excel 里「另存为」.xlsx 再导入',
      );
    case 'cfb':
      return tr('这个文件不是 Excel 工作簿（可能是改了扩展名的 Word 或其他 Office 旧格式文件）');
    case 'empty':
      return tr('文件是空的');
    default:
      return tr(
        '这个文件不是 .xlsx 格式（可能只是改了扩展名），请在 Excel 里「另存为」.xlsx 再导入',
      );
  }
}

export interface XlsxChartInfo {
  /** 图表标题；没有标题时用绘图对象名（如「Chart 1」） */
  title: string;
  /** 图表所在的工作表 */
  sheet?: string;
  /** 数据系列引用的区域，去掉 $ 和引号，例如「实验数据!A2:A5」 */
  refs: string[];
}

export interface XlsxPackageResult {
  /** 交给 ExcelJS 的字节；没有改动时就是原数组 */
  bytes: Uint8Array;
  changed: boolean;
  charts: XlsxChartInfo[];
  images: number;
  shapes: number;
}

export class XlsxPackageError extends Error {}

// ------------------------------------------------------------------ OPC 小工具

const norm = (name: string) => name.replace(/^\/+/u, '');

function dirOf(part: string): string {
  const i = part.lastIndexOf('/');
  return i < 0 ? '' : part.slice(0, i);
}

/** part 的 rels 路径：xl/worksheets/sheet1.xml → xl/worksheets/_rels/sheet1.xml.rels */
function relsPathOf(part: string): string {
  const d = dirOf(part);
  const f = part.slice(d ? d.length + 1 : 0);
  return `${d ? `${d}/` : ''}_rels/${f}.rels`;
}

/** rels 路径 → 它描述的 part：xl/worksheets/_rels/sheet1.xml.rels → xl/worksheets/sheet1.xml */
function sourceOfRels(relsPath: string): string | null {
  const m = /^(.*?)(?:^|\/)_rels\/([^/]+)\.rels$/u.exec(relsPath);
  if (!m) return null;
  return m[1] ? `${m[1]}/${m[2]}` : m[2]!;
}

/** 按 OPC 规则把 rel Target 解析成包内路径（支持绝对路径 /xl/... 和 ../ 相对路径） */
function resolveTarget(sourcePart: string, target: string): string {
  const t = decodeURIComponent(target.trim());
  const segs = t.startsWith('/') ? [] : dirOf(sourcePart).split('/').filter(Boolean);
  for (const s of t.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') segs.pop();
    else segs.push(s);
  }
  return segs.join('/');
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? Number.parseInt(k.slice(2), 16) : Number(k.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u').exec(tag);
  if (!m) return undefined;
  return decodeXml(m[1] ?? m[2] ?? '');
}

/** r:id（前缀不一定是 r） */
function relIdAttr(tag: string): string | undefined {
  const m = /\s[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** 原文，删除时用 */
  xml: string;
}

function parseRels(xml: string): Rel[] {
  const out: Rel[] = [];
  const re = /<(?:[\w.-]+:)?Relationship\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?Relationship>)/gu;
  for (const m of xml.matchAll(re)) {
    const tag = m[0];
    out.push({
      id: attr(tag, 'Id') ?? '',
      type: attr(tag, 'Type') ?? '',
      target: attr(tag, 'Target') ?? '',
      external: (attr(tag, 'TargetMode') ?? '').toLowerCase() === 'external',
      xml: tag,
    });
  }
  return out;
}

// ------------------------------------------------------------------ 图表信息

const DRAWING_PART = /^xl\/drawings\/[^/]+\.xml$/iu;
const DRAWING_RELS = /^xl\/drawings\/_rels\/[^/]+\.xml\.rels$/iu;
const CHART_PART = /^xl\/charts\//iu;

function isStripped(path: string): boolean {
  return DRAWING_PART.test(path) || DRAWING_RELS.test(path) || CHART_PART.test(path);
}

/** 「'实验数据'!$A$2:$A$5」→「实验数据!A2:A5」；多区域 (A,B) 拆开 */
function cleanRefs(f: string): string[] {
  const s = f.trim().replace(/^\(|\)$/gu, '');
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of s) {
    if (ch === "'") quoted = !quoted;
    if (ch === ',' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => {
      const t = p.trim();
      const bang = t.lastIndexOf('!');
      if (bang < 0) return t.replace(/\$/gu, '');
      let sheet = t.slice(0, bang);
      if (sheet.startsWith("'") && sheet.endsWith("'"))
        sheet = sheet.slice(1, -1).replace(/''/gu, "'");
      return `${sheet}!${t.slice(bang + 1).replace(/\$/gu, '')}`;
    })
    .filter(Boolean);
}

function textRuns(xml: string): string {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?t>/gu))
    out.push(decodeXml(m[1]!));
  return out.join('').trim();
}

function formulas(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?f(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?f>/gu)) {
    const f = decodeXml(m[1]!).trim();
    if (f) out.push(f);
  }
  return out;
}

function chartInfo(xml: string, fallbackTitle: string, sheet?: string): XlsxChartInfo {
  // 图表自己的标题在 plotArea 之前；坐标轴标题在 plotArea 里面，不要
  const plot = xml.search(/<(?:[\w.-]+:)?plotArea\b/u);
  const head = plot >= 0 ? xml.slice(0, plot) : xml;
  const titleM = /<((?:[\w.-]+:)?)title\b[^>]*>([\s\S]*?)<\/\1title>/u.exec(head);
  let title = titleM ? textRuns(titleM[2]!) : '';
  if (!title && titleM) {
    // 标题引用单元格：<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f>…<c:v>缓存</c:v>
    const v = /<(?:[\w.-]+:)?v>([^<]*)</u.exec(titleM[2]!);
    if (v) title = decodeXml(v[1]!).trim();
  }
  // 数据范围：分类 / 值 / 散点 X、Y / 气泡大小里的 <c:f>（不含系列名）
  const refs: string[] = [];
  const blocks = /<((?:[\w.-]+:)?)(cat|val|xVal|yVal|bubbleSize)\b[^>]*>([\s\S]*?)<\/\1\2>/gu;
  for (const m of xml.matchAll(blocks)) refs.push(...formulas(m[3]!).flatMap(cleanRefs));
  // chartEx（瀑布图、直方图等）没有上面这些元素：退回取全部 <cx:f>
  if (refs.length === 0) refs.push(...formulas(xml).flatMap(cleanRefs));
  return { title: title || fallbackTitle, sheet, refs: [...new Set(refs)] };
}

/** 引用列表的人话：同一张表的合并写，「实验数据!A2:A5、C2:C5」 */
export function formatChartRefs(refs: string[], max = 4): string {
  const groups = new Map<string, string[]>();
  for (const r of refs) {
    const bang = r.lastIndexOf('!');
    const sheet = bang < 0 ? '' : r.slice(0, bang);
    const range = bang < 0 ? r : r.slice(bang + 1);
    const list = groups.get(sheet) ?? [];
    list.push(range);
    groups.set(sheet, list);
  }
  const parts: string[] = [];
  let shown = 0;
  for (const [sheet, ranges] of groups) {
    const take = ranges.slice(0, Math.max(0, max - shown));
    if (take.length === 0) break;
    shown += take.length;
    parts.push(`${sheet ? `${sheet}!` : ''}${take.join(tr('、'))}`);
  }
  const more = refs.length - shown;
  return parts.join(tr('、')) + (more > 0 ? tr(' 等 {count} 处', { count: refs.length }) : '');
}

// ------------------------------------------------------------------ 主流程

/**
 * 解压、数出并剥掉 drawing / chart，再压回去。
 * - 解压失败抛 XlsxPackageError('corrupt')，调用方可以退回把原文件交给 ExcelJS 再试一次；
 * - 包里没有 xl/workbook.xml 时抛带中文提示的 XlsxPackageError。
 */
export function prepareXlsxPackage(bytes: Uint8Array): XlsxPackageResult {
  let zip: Unzipped;
  try {
    // 先只看目录（不解压）：大多数文件没有绘图层，原样交给 ExcelJS，省一次解压 + 压缩
    const names: string[] = [];
    unzipSync(bytes, {
      filter: (f) => {
        names.push(norm(f.name).toLowerCase());
        return false;
      },
    });
    const hasWorkbook = names.includes('xl/workbook.xml');
    if (hasWorkbook && !names.some(isStripped))
      return { bytes, changed: false, charts: [], images: 0, shapes: 0 };
    zip = unzipSync(bytes);
  } catch {
    throw new XlsxPackageError('corrupt');
  }
  // 统一成无前导 / 的路径；OPC 的 part 名不区分大小写
  const files = new Map<string, { key: string; data: Uint8Array }>();
  for (const [key, data] of Object.entries(zip)) {
    if (key.endsWith('/')) continue;
    files.set(norm(key).toLowerCase(), { key, data });
  }
  const read = (path: string) => {
    const f = files.get(path.toLowerCase());
    return f ? strFromU8(f.data) : null;
  };

  if (!files.has('xl/workbook.xml')) {
    if (files.has('xl/workbook.bin'))
      throw new XlsxPackageError(
        tr('这是 Excel 二进制工作簿（.xlsb），暂不支持。请在 Excel 里「另存为」.xlsx 再导入'),
      );
    if (files.has('word/document.xml'))
      throw new XlsxPackageError(tr('这是一个 Word 文档，不是 Excel 工作簿'));
    if (files.has('ppt/presentation.xml'))
      throw new XlsxPackageError(tr('这是一个 PowerPoint 演示文稿，不是 Excel 工作簿'));
    throw new XlsxPackageError(tr('这个文件不是 Excel 工作簿（压缩包里没有 xl/workbook.xml）'));
  }

  const stripped = [...files.keys()].filter(isStripped);
  if (stripped.length === 0) return { bytes, changed: false, charts: [], images: 0, shapes: 0 };

  // ---- 1. 统计：工作表 → drawing → 图表 / 图片 / 形状
  const sheetNameByPart = new Map<string, string>();
  const wbXml = read('xl/workbook.xml') ?? '';
  const wbRels = parseRels(read('xl/_rels/workbook.xml.rels') ?? '');
  for (const m of wbXml.matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/gu)) {
    const rid = relIdAttr(m[0]);
    const name = attr(m[0], 'name');
    const rel = wbRels.find((r) => r.id === rid);
    if (rel && name)
      sheetNameByPart.set(resolveTarget('xl/workbook.xml', rel.target).toLowerCase(), name);
  }

  const charts: XlsxChartInfo[] = [];
  const seenCharts = new Set<string>();
  let images = 0;
  let shapes = 0;
  const drawingOwner = new Map<string, string>();
  for (const [sheetPart, sheetName] of sheetNameByPart) {
    for (const rel of parseRels(read(relsPathOf(sheetPart)) ?? '')) {
      if (rel.external || !/\/drawing$/u.test(rel.type)) continue;
      drawingOwner.set(resolveTarget(sheetPart, rel.target).toLowerCase(), sheetName);
    }
  }
  for (const path of stripped) {
    if (!DRAWING_PART.test(path)) continue;
    const xml = read(path) ?? '';
    const sheet = drawingOwner.get(path);
    const rels = parseRels(read(relsPathOf(path)) ?? '');
    const anchors = xml.matchAll(
      /<((?:[\w.-]+:)?)(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/\1\2>/gu,
    );
    for (const a of anchors) {
      const body = a[0];
      const chartTags = [...body.matchAll(/<(?:[\w.-]+:)?chart\b[^>]*>/gu)].filter((t) =>
        relIdAttr(t[0]),
      );
      const pics = body.match(/<(?:[\w.-]+:)?pic[\s>]/gu)?.length ?? 0;
      images += pics;
      if (chartTags.length === 0) {
        if (pics === 0 && /<(?:[\w.-]+:)?(sp|cxnSp|grpSp)[\s>]/u.test(body)) shapes += 1;
        continue;
      }
      const objName = attr(/<(?:[\w.-]+:)?cNvPr\b[^>]*>/u.exec(body)?.[0] ?? '', 'name');
      for (const t of chartTags) {
        const rel = rels.find((r) => r.id === relIdAttr(t[0]));
        const chartPath = rel ? resolveTarget(path, rel.target).toLowerCase() : '';
        if (chartPath) seenCharts.add(chartPath);
        const chartXml = chartPath ? read(chartPath) : null;
        const fallback = objName || tr('图表 {value}', { value: charts.length + 1 });
        charts.push(
          chartXml ? chartInfo(chartXml, fallback, sheet) : { title: fallback, sheet, refs: [] },
        );
      }
    }
  }
  // 没被任何 drawing 引用到的图表（例如图表工作表里那种）也算上
  for (const path of stripped) {
    if (!/^xl\/charts\/(chart|chartex)[^/]*\.xml$/iu.test(path) || seenCharts.has(path)) continue;
    charts.push(chartInfo(read(path) ?? '', tr('图表 {value}', { value: charts.length + 1 })));
  }

  // ---- 2. 剥离
  const removed = new Set(stripped);
  const out: Record<string, Uint8Array> = {};
  /** part → 被删掉的关系 id（之后在 part XML 里删掉对应的 <drawing r:id/>） */
  const droppedIds = new Map<string, Set<string>>();
  for (const [path, f] of files) {
    if (removed.has(path)) continue;
    if (!path.endsWith('.rels')) continue;
    const src = sourceOfRels(path);
    if (!src) continue;
    const xml = strFromU8(f.data);
    let next = xml;
    for (const rel of parseRels(xml)) {
      const dead =
        !rel.external &&
        (removed.has(resolveTarget(src, rel.target).toLowerCase()) ||
          /\/(drawing|chart)$/u.test(rel.type));
      if (!dead) continue;
      next = next.replace(rel.xml, '');
      const set = droppedIds.get(src) ?? new Set<string>();
      set.add(rel.id);
      droppedIds.set(src, set);
    }
    if (next !== xml) f.data = strToU8(next);
  }
  for (const [src, ids] of droppedIds) {
    const f = files.get(src);
    if (!f) continue;
    const xml = strFromU8(f.data);
    const next = xml.replace(
      /<((?:[\w.-]+:)?)drawing\b[^>]*?(?:\/>|>[\s\S]*?<\/\1drawing>)/gu,
      (tag) => (ids.has(relIdAttr(tag) ?? '') ? '' : tag),
    );
    if (next !== xml) f.data = strToU8(next);
  }
  const ct = files.get('[content_types].xml');
  if (ct) {
    const xml = strFromU8(ct.data);
    const next = xml.replace(
      /<(?:[\w.-]+:)?Override\b[^>]*>(?:\s*<\/(?:[\w.-]+:)?Override>)?/gu,
      (tag) => (removed.has(norm(attr(tag, 'PartName') ?? '').toLowerCase()) ? '' : tag),
    );
    if (next !== xml) ct.data = strToU8(next);
  }
  for (const [path, f] of files) if (!removed.has(path)) out[f.key] = f.data;
  // 只在内存里交给 ExcelJS，不压缩（快）
  return { bytes: zipSync(out, { level: 0 }), changed: true, charts, images, shapes };
}

/** 把统计结果写成给用户看的 warnings */
export function packageWarnings(
  pkg: Pick<XlsxPackageResult, 'charts' | 'images' | 'shapes'>,
): string[] {
  const out: string[] = [];
  const n = pkg.charts.length;
  if (n) {
    out.push(tr('图表未导入（{n} 个，表格暂不支持图表），数据和公式已正常导入', { n }));
    const show = pkg.charts.slice(0, 3);
    for (const c of show) {
      out.push(
        c.refs.length
          ? tr('图表「{title}」引用 {value}，已跳过', {
              title: c.title,
              value: formatChartRefs(c.refs),
            })
          : tr('图表「{title}」{value}已跳过', {
              title: c.title,
              value: c.sheet ? tr('（在「{sheet}」表上）', { sheet: c.sheet }) : '',
            }),
      );
    }
    if (n > show.length) out.push(tr('另有 {value} 个图表已跳过', { value: n - show.length }));
  }
  if (pkg.images)
    out.push(tr('图片未导入（{images} 张，表格暂不支持图片）', { images: pkg.images }));
  if (pkg.shapes) out.push(tr('形状和文本框未导入（{shapes} 个）', { shapes: pkg.shapes }));
  return out;
}
