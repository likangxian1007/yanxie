/**
 * CSV / TSV（RFC 4180 引号规则）：字段含分隔符、引号、换行或首尾空格时用双引号包起，
 * 内部引号写成两个。TSV 是 Excel / 飞书 / Google 表格复制到剪贴板的格式（同样的引号规则）。
 *
 * parseCsv 对流式输出容错：末尾未闭合的引号字段按已收到的内容返回；去掉 AI 偶尔加的 ``` 围栏。
 */

export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let i = 0;
  const s = text.replace(/^\uFEFF/u, '');
  while (i < s.length) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }
  if (fieldStarted || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 去掉 ```csv … ``` 围栏（AI 偶尔不守约定）。 */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```[\w-]*\s*\n([\s\S]*?)(?:\n```\s*)?$/u.exec(t);
  return m ? (m[1] ?? '') : text;
}

export function parseCsv(text: string): string[][] {
  return parseDelimited(stripFences(text), ',');
}

export function parseTsv(text: string): string[][] {
  // 剪贴板末尾常带一个换行：parseDelimited 不会因此多出空行
  return parseDelimited(text, '\t');
}

function quoteField(value: string, delimiter: string): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    (delimiter === ',' && /^\s|\s$/u.test(value))
  ) {
    return `"${value.replace(/"/gu, '""')}"`;
  }
  return value;
}

export function toDelimited(rows: string[][], delimiter: string, eol = '\n'): string {
  return rows.map((r) => r.map((v) => quoteField(v, delimiter)).join(delimiter)).join(eol);
}

export function toCsv(rows: string[][]): string {
  return toDelimited(rows, ',', '\r\n');
}

export function toTsv(rows: string[][]): string {
  return toDelimited(rows, '\t', '\n');
}
