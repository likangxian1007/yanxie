/** 摘要的前几行（去掉空行、markdown 记号与表格分隔行） */
export function excerptLines(excerpt: string, max: number): string[] {
  return excerpt
    .split(/\r?\n/u)
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/u, '').trim())
    .filter((l) => l && !/^\|?\s*:?-{3,}/u.test(l))
    .slice(0, max);
}

/** 表格摘要 → 二维单元格（制表符 / 竖线 / 逗号分隔） */
export function excerptCells(excerpt: string, rows: number, cols: number): string[][] {
  return excerptLines(excerpt, rows).map((line) =>
    line
      .replace(/^\||\|$/gu, '')
      .split(/\t|\s*\|\s*|,\s*/u)
      .slice(0, cols)
      .map((c) => c.trim()),
  );
}
