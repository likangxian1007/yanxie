/**
 * 行级 diff（LCS），像 PR 的 Files changed：发起审阅时的快照 vs 当前内容。
 * 先剥掉公共前后缀，再对中间部分做 LCS 动态规划；超大输入退化为“整段删除 + 整段新增”。
 */

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 旧版本行号（从 1 开始），新增行为 null */
  oldNo: number | null;
  /** 新版本行号（从 1 开始），删除行为 null */
  newNo: number | null;
}

/** LCS 表的格子上限（约 16MB 的 Uint32Array） */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  // 末尾换行不算一行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const out: DiffLine[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  for (let i = 0; i < start; i += 1) {
    out.push({ kind: 'same', text: a[i] as string, oldNo: i + 1, newNo: i + 1 });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
      midA.forEach((text, i) => out.push({ kind: 'del', text, oldNo: start + i + 1, newNo: null }));
      midB.forEach((text, j) => out.push({ kind: 'add', text, oldNo: null, newNo: start + j + 1 }));
    } else {
      // dp[i][j] = midA[i..] 与 midB[j..] 的 LCS 长度
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i * w + j] =
            midA[i] === midB[j]
              ? (dp[(i + 1) * w + j + 1] as number) + 1
              : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (midA[i] === midB[j]) {
          out.push({
            kind: 'same',
            text: midA[i] as string,
            oldNo: start + i + 1,
            newNo: start + j + 1,
          });
          i += 1;
          j += 1;
        } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
          // 同长时先出删除行，再出新增行（与 git 的习惯一致）
          out.push({ kind: 'del', text: midA[i] as string, oldNo: start + i + 1, newNo: null });
          i += 1;
        } else {
          out.push({ kind: 'add', text: midB[j] as string, oldNo: null, newNo: start + j + 1 });
          j += 1;
        }
      }
      for (; i < n; i += 1) {
        out.push({ kind: 'del', text: midA[i] as string, oldNo: start + i + 1, newNo: null });
      }
      for (; j < m; j += 1) {
        out.push({ kind: 'add', text: midB[j] as string, oldNo: null, newNo: start + j + 1 });
      }
    }
  }

  const shift = endB - endA;
  for (let i = endA; i < a.length; i += 1) {
    out.push({ kind: 'same', text: a[i] as string, oldNo: i + 1, newNo: i + 1 + shift });
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added += 1;
    else if (l.kind === 'del') removed += 1;
  }
  return { added, removed };
}

export type DiffSegment =
  { type: 'lines'; lines: DiffLine[] } | { type: 'collapsed'; id: string; lines: DiffLine[] };

/**
 * 把大段未改动的行折叠起来（改动上下各留 context 行），像 PR 里的“展开 N 行”。
 * 没有任何改动时整篇折叠为一段。
 */
export function toSegments(lines: DiffLine[], context = 3, minCollapse = 4): DiffSegment[] {
  const changed = lines.map((l) => l.kind !== 'same');
  const keep = new Array<boolean>(lines.length).fill(false);
  changed.forEach((c, i) => {
    if (!c) return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1) {
      keep[k] = true;
    }
  });

  const segments: DiffSegment[] = [];
  let i = 0;
  while (i < lines.length) {
    const kept = keep[i];
    let j = i;
    while (j < lines.length && keep[j] === kept) j += 1;
    const chunk = lines.slice(i, j);
    if (!kept && chunk.length >= minCollapse) {
      segments.push({ type: 'collapsed', id: `c${i}`, lines: chunk });
    } else {
      const last = segments[segments.length - 1];
      if (last?.type === 'lines') last.lines.push(...chunk);
      else segments.push({ type: 'lines', lines: chunk });
    }
    i = j;
  }
  return segments;
}
