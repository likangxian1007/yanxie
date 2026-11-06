/** tabular 列格式与长度的解析（纯函数）。 */

export interface ColSpec {
  /** 每列对齐：l / c / r */
  aligns: Array<'l' | 'c' | 'r'>;
  /** borders[k] = 第 k 列左侧是否有竖线（k = 列数 时为最右侧） */
  borders: boolean[];
  count: number;
}

/** 从 str[i] === '{' 起，返回配对 } 之后的下标 */
function skipGroup(str: string, i: number): number {
  if (str[i] !== '{') return i;
  let depth = 0;
  for (let j = i; j < str.length; j += 1) {
    if (str[j] === '{') depth += 1;
    else if (str[j] === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return str.length;
}

function readGroup(str: string, i: number): { text: string; next: number } {
  let k = i;
  while (k < str.length && /\s/.test(str[k] ?? '')) k += 1;
  if (str[k] !== '{') return { text: str[k] ?? '', next: k + 1 };
  const next = skipGroup(str, k);
  return { text: str.slice(k + 1, next - 1), next };
}

/** 展开 *{n}{spec} */
function expandRepeats(spec: string): string {
  let out = spec;
  for (let guard = 0; guard < 20; guard += 1) {
    const at = out.indexOf('*');
    if (at === -1) break;
    const count = readGroup(out, at + 1);
    const body = readGroup(out, count.next);
    const n = Math.min(50, Math.max(0, Number.parseInt(count.text, 10) || 0));
    out = out.slice(0, at) + body.text.repeat(n) + out.slice(body.next);
  }
  return out;
}

export function parseColSpec(raw: string): ColSpec {
  const spec = expandRepeats(raw);
  const aligns: ColSpec['aligns'] = [];
  const borders: boolean[] = [false];
  let i = 0;
  while (i < spec.length) {
    const c = spec[i] ?? '';
    if (c === '|') {
      borders[aligns.length] = true;
      i += 1;
      continue;
    }
    if (c === '@' || c === '!' || c === '>' || c === '<') {
      i = readGroup(spec, i + 1).next;
      continue;
    }
    if (c === 'p' || c === 'm' || c === 'b') {
      aligns.push('l');
      borders.push(false);
      i = readGroup(spec, i + 1).next;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const lower = c.toLowerCase();
      aligns.push(lower === 'c' || c === 'S' ? 'c' : lower === 'r' ? 'r' : 'l');
      borders.push(false);
      i += 1;
      continue;
    }
    i += 1;
  }
  return { aligns, borders, count: aligns.length };
}

/** LaTeX 长度 → CSS 宽度（0.5\textwidth → 50%，5cm → 5cm），认不出返回 null */
export function parseLength(raw: string): string | null {
  const text = raw.trim();
  const rel = /^([\d.]*)\s*\\(linewidth|textwidth|columnwidth|hsize)$/.exec(text);
  if (rel) {
    const v = rel[1] ? Number(rel[1]) : 1;
    if (!Number.isFinite(v) || v <= 0) return null;
    return `${Math.min(100, Math.round(v * 1000) / 10)}%`;
  }
  const abs = /^([\d.]+)\s*(cm|mm|in|pt|em|ex|px)$/.exec(text);
  if (abs) {
    const v = Number(abs[1]);
    if (!Number.isFinite(v) || v <= 0) return null;
    return `min(100%, ${v}${abs[2]})`;
  }
  return null;
}
