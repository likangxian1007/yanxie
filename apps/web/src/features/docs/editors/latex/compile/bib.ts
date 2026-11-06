import { tr } from '@/lib/i18n';
/**
 * 轻量 .bib 解析（草稿预览给引用编号、列参考文献用；真正的排版交给 BibTeX）。
 * 支持 `@type{key, field = {…} | "…" | 数字 | 宏 # 拼接}`、@string 宏、@comment / @preamble 跳过、
 * 花括号嵌套与 `%` 注释行。纯函数，测试见 bib.test.ts。
 */

export interface BibEntry {
  type: string;
  key: string;
  /** 字段名小写；值去掉了外层花括号 / 引号 */
  fields: Record<string, string>;
  /** 条目在 .bib 里开始的行（1 起） */
  line: number;
}

export interface BibParseResult {
  entries: BibEntry[];
  errors: { line: number; message: string }[];
}

const MONTHS: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};

export function parseBib(src: string): BibParseResult {
  const text = src.replace(/\r\n?/gu, '\n');
  const entries: BibEntry[] = [];
  const errors: { line: number; message: string }[] = [];
  const strings: Record<string, string> = { ...MONTHS };
  const lineAt = (pos: number) => text.slice(0, pos).split('\n').length;
  let i = 0;

  const skipWs = () => {
    for (;;) {
      while (i < text.length && /\s/u.test(text[i]!)) i += 1;
      // .bib 里 % 开头的行通常当注释
      if (text[i] === '%') {
        while (i < text.length && text[i] !== '\n') i += 1;
        continue;
      }
      break;
    }
  };

  const readBraced = (): string | null => {
    // text[i] === '{'
    let depth = 0;
    const start = i;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          return text.slice(start + 1, i - 1);
        }
      }
    }
    return null;
  };

  const readQuoted = (): string | null => {
    // text[i] === '"'
    let depth = 0;
    const start = i + 1;
    for (i += 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '"' && depth === 0) {
        i += 1;
        return text.slice(start, i - 1);
      }
    }
    return null;
  };

  const readValue = (): string | null => {
    const parts: string[] = [];
    for (;;) {
      skipWs();
      const ch = text[i];
      let part: string | null;
      if (ch === '{') part = readBraced();
      else if (ch === '"') part = readQuoted();
      else {
        const m = /^[A-Za-z0-9_:.+\-/]+/u.exec(text.slice(i));
        if (!m) return null;
        i += m[0].length;
        part = /^\d+$/u.test(m[0]) ? m[0] : (strings[m[0].toLowerCase()] ?? m[0]);
      }
      if (part === null) return null;
      parts.push(part);
      skipWs();
      if (text[i] === '#') {
        i += 1;
        continue;
      }
      return parts.join('');
    }
  };

  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    // % 开头的行当注释（biber 的规则；BibTeX 本身会把条目外的文字都忽略）
    const lineStart = text.lastIndexOf('\n', at) + 1;
    if (text.slice(lineStart, at).trimStart().startsWith('%')) continue;
    const typeMatch = /^[A-Za-z]+/u.exec(text.slice(i));
    if (!typeMatch) continue;
    const type = typeMatch[0].toLowerCase();
    i += typeMatch[0].length;
    skipWs();
    const open = text[i];
    if (open !== '{' && open !== '(') continue;
    const close = open === '{' ? '}' : ')';
    const startLine = lineAt(at);
    if (type === 'comment' || type === 'preamble') {
      if (open === '{') readBraced();
      else i += 1;
      continue;
    }
    i += 1;
    skipWs();
    if (type === 'string') {
      const nm = /^[A-Za-z][A-Za-z0-9_:-]*/u.exec(text.slice(i));
      if (!nm) continue;
      i += nm[0].length;
      skipWs();
      if (text[i] !== '=') continue;
      i += 1;
      const v = readValue();
      if (v !== null) strings[nm[0].toLowerCase()] = v;
      skipWs();
      if (text[i] === close) i += 1;
      continue;
    }
    const keyMatch = /^[^,\s{}()"#%'=]+/u.exec(text.slice(i));
    if (!keyMatch) {
      errors.push({ line: startLine, message: tr('@{type} 条目缺少 key', { type }) });
      continue;
    }
    const key = keyMatch[0];
    i += key.length;
    skipWs();
    const fields: Record<string, string> = {};
    let ok = true;
    if (text[i] === ',') {
      i += 1;
      for (;;) {
        skipWs();
        if (text[i] === close) {
          i += 1;
          break;
        }
        if (i >= text.length) {
          errors.push({ line: startLine, message: tr('条目 {key} 没有闭合', { key }) });
          ok = false;
          break;
        }
        const fm = /^[A-Za-z][A-Za-z0-9_:+\-.]*/u.exec(text.slice(i));
        if (!fm) {
          errors.push({ line: lineAt(i), message: tr('条目 {key} 的字段格式不对', { key }) });
          ok = false;
          // 跳到下一个条目
          const nextAt = text.indexOf('\n@', i);
          i = nextAt < 0 ? text.length : nextAt + 1;
          break;
        }
        i += fm[0].length;
        skipWs();
        if (text[i] !== '=') {
          errors.push({
            line: lineAt(i),
            message: tr('条目 {key} 的字段 {value} 后面缺少 =', { key, value: fm[0] }),
          });
          ok = false;
          const nextAt = text.indexOf('\n@', i);
          i = nextAt < 0 ? text.length : nextAt + 1;
          break;
        }
        i += 1;
        const valueStart = i;
        const v = readValue();
        if (v === null) {
          errors.push({
            line: lineAt(valueStart),
            message: tr('条目 {key} 的字段 {value} 的值没有闭合', { key, value: fm[0] }),
          });
          ok = false;
          const nextAt = text.indexOf('\n@', valueStart);
          i = nextAt < 0 ? text.length : nextAt + 1;
          break;
        }
        fields[fm[0].toLowerCase()] = v.replace(/\s+/gu, ' ').trim();
        skipWs();
        if (text[i] === ',') i += 1;
      }
    } else if (text[i] === close) {
      i += 1;
    }
    if (ok || Object.keys(fields).length > 0) {
      entries.push({ type, key, fields, line: startLine });
    }
  }
  return { entries, errors };
}

/** 去掉 BibTeX 值里的花括号保护、常见重音命令和 ~ */
export function bibText(value: string): string {
  return value
    .replace(/\\[`'^"~=.uvHtcdbk]\s*\{?([A-Za-z])\}?/gu, '$1')
    .replace(/\\(?:textbf|textit|emph|textsc|mathrm|mathbf)\s*\{([^{}]*)\}/gu, '$1')
    .replace(/\\&/gu, '&')
    .replace(/[{}]/gu, '')
    .replace(/~/gu, ' ')
    .replace(/--/gu, '–')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** "He, Kaiming and Zhang, Xiangyu and others" → ["Kaiming He", "Xiangyu Zhang", "others"] */
export function splitAuthors(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  const words = value.split(/(\s+)/u);
  for (const w of words) {
    for (const ch of w) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth === 0 && w.toLowerCase() === 'and') {
      parts.push(cur.trim());
      cur = '';
    } else cur += w;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean).map((p) => {
    const t = bibText(p);
    if (t.toLowerCase() === 'others') return 'others';
    const comma = t.indexOf(',');
    return comma > 0 ? `${t.slice(comma + 1).trim()} ${t.slice(0, comma).trim()}`.trim() : t;
  });
}

/** 一条参考文献的展示文字：作者. 标题. 出处, 年份. */
export function formatBibEntry(entry: BibEntry): {
  authors: string;
  title: string;
  venue: string;
  year: string;
} {
  const f = entry.fields;
  const list = splitAuthors(f.author ?? f.editor ?? '');
  const hasOthers = list[list.length - 1] === 'others';
  const names = list.filter((n) => n !== 'others');
  let authors =
    names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  if (hasOthers || names.length > 6) authors = `${names[0] ?? ''} et al.`;
  const venue = bibText(
    f.journal ??
      f.booktitle ??
      f.publisher ??
      f.school ??
      f.institution ??
      f.howpublished ??
      (f.eprint ? `arXiv:${f.eprint}` : ''),
  );
  return {
    authors: authors.trim(),
    title: bibText(f.title ?? ''),
    venue,
    year: bibText(f.year ?? f.date?.slice(0, 4) ?? ''),
  };
}
