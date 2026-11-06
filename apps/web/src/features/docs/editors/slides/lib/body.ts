/**
 * 幻灯片正文（markdown 子集）解析成块和行内片段，画布渲染与 PPTX 导出共用，保证两边一致：
 * - 块：段落（连续非空行合并，行间保留换行）、无序列表 `- `/`* `/`+ `、有序列表 `1. `、
 *   标题行 `# …`（按加粗段落处理）；空行分段。列表每 2 个空格缩进一级（最多 3 级）。
 * - 行内：`**粗体**`、`$公式$`（也接受 `$$公式$$`）、`` `代码` ``；`\$` 表示字面的美元符号。
 */

export interface Run {
  text: string;
  bold?: boolean;
  math?: boolean;
  code?: boolean;
}

export type Block =
  | { kind: 'p'; runs: Run[] }
  | { kind: 'h'; runs: Run[] }
  | { kind: 'li'; ordered: boolean; number: number; level: number; runs: Run[] };

const UL = /^(\s*)[-*+]\s+(.*)$/u;
const OL = /^(\s*)(\d+)[.)]\s+(.*)$/u;
const HEADING = /^#{1,6}\s+(.*)$/u;
const ESC = '\u0000';

export function parseInline(text: string): Run[] {
  const src = text.replace(/\\\$/gu, ESC);
  const re = /\*\*([^*]+?)\*\*|\$\$([^$]+?)\$\$|\$([^$\n]+?)\$|`([^`]+?)`/gu;
  const runs: Run[] = [];
  let last = 0;
  const push = (run: Run) => {
    const t = run.text.replaceAll(ESC, '$');
    if (!t) return;
    const prev = runs[runs.length - 1];
    if (prev && !prev.bold && !prev.math && !prev.code && !run.bold && !run.math && !run.code) {
      prev.text += t;
    } else runs.push({ ...run, text: t });
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) push({ text: src.slice(last, m.index) });
    if (m[1] !== undefined) push({ text: m[1], bold: true });
    else if (m[2] !== undefined) push({ text: m[2].trim(), math: true });
    else if (m[3] !== undefined) push({ text: m[3].trim(), math: true });
    else if (m[4] !== undefined) push({ text: m[4], code: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) push({ text: src.slice(last) });
  return runs;
}

export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] | null = null;
  const counters: number[] = [];
  const flush = () => {
    if (para && para.length) {
      const runs: Run[] = [];
      para.forEach((line, i) => {
        if (i > 0) runs.push({ text: '\n' });
        runs.push(...parseInline(line));
      });
      blocks.push({ kind: 'p', runs: mergeText(runs) });
    }
    para = null;
  };
  for (const raw of body.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = raw.replace(/\t/gu, '  ');
    if (line.trim() === '') {
      flush();
      counters.length = 0;
      continue;
    }
    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      flush();
      const indent = (ul ? ul[1] : ol?.[1])?.length ?? 0;
      const level = Math.min(2, Math.floor(indent / 2));
      const text = (ul ? ul[2] : ol?.[3]) ?? '';
      let number = 0;
      if (ol) {
        counters.length = level + 1;
        number = counters[level] === undefined ? Number(ol[2]) : (counters[level] as number) + 1;
        counters[level] = number;
      }
      blocks.push({
        kind: 'li',
        ordered: Boolean(ol),
        number,
        level,
        runs: parseInline(text.trim()),
      });
      continue;
    }
    const h = HEADING.exec(line.trim());
    if (h) {
      flush();
      blocks.push({ kind: 'h', runs: parseInline(h[1] ?? '') });
      continue;
    }
    if (!para) para = [];
    para.push(line.trim());
  }
  flush();
  return blocks;
}

function mergeText(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && !prev.bold && !prev.math && !prev.code && !r.bold && !r.math && !r.code)
      prev.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

/** 正文的纯文本（缩略图 aria、搜索用） */
export function plainText(body: string): string {
  return parseBody(body)
    .map((b) => b.runs.map((r) => r.text).join(''))
    .join('\n');
}
