import { tr } from '@/lib/i18n';
/**
 * TeX 编译日志 → 问题列表（错误 / 警告，带文件和行号）。纯函数，测试见 texLog.test.ts。
 *
 * 支持的日志格式：
 * - TeX 经典格式：`! 错误信息` + 后面的 `l.<行号> …`；所在文件由日志里的 `(文件名` / `)` 嵌套推断
 * - -file-line-error 格式：`./main.tex:12: 错误信息`
 * - `LaTeX Warning:` / `Package xxx Warning:` / `Class xxx Warning:`（多行续行以 `(xxx)` 开头）
 * - `Overfull / Underfull \hbox`（排版提示）
 * - 服务端拼在后面的 BibTeX 日志（`---- BibTeX` 段）和 `研协：` 提示
 */

export type TexIssueKind =
  | 'undefined_control'
  | 'undefined_citation'
  | 'undefined_reference'
  | 'missing_bib'
  | 'missing_file'
  | 'bibtex'
  | 'badbox'
  | 'other';

export interface TexIssue {
  severity: 'error' | 'warning' | 'info';
  /** 工程内文件名（如 main.tex、references.bib）；推断不出时为 null */
  file: string | null;
  line: number | null;
  /** 给人看的说明（常见错误翻成中文） */
  message: string;
  kind: TexIssueKind;
  /** 让 AI 修复有意义（源码里的真错误；缺参考文献、缺文件、排版提示都不算） */
  fixable: boolean;
  /** 原始日志片段 */
  raw: string;
}

const MAX_LINE = 79;

/** TeX 默认每 79 个字符折一行：把折行拼回去 */
export function unwrapLog(log: string): string[] {
  const lines = log.replace(/\r\n?/gu, '\n').split('\n');
  const out: string[] = [];
  let cur = '';
  let joining = false;
  for (const line of lines) {
    cur = joining ? cur + line : line;
    // 正好 79 个字符的行（不含一些天然就长的行）多半是被折断的
    joining = line.length === MAX_LINE && !/^(?:! |l\.\d+ )/u.test(line);
    if (!joining) {
      out.push(cur);
      cur = '';
    }
  }
  if (joining) out.push(cur);
  return out;
}

function normFile(path: string): string {
  let p = path.trim().replace(/\\/gu, '/');
  while (p.startsWith('./')) p = p.slice(2);
  // 工作目录里的绝对路径（latexmk 等）：只留最后一段工程内路径
  const tmp = /\/srh-latex-[^/]+\/(.+)$/u.exec(p);
  if (tmp) p = tmp[1]!;
  return p;
}

const FILE_TOKEN =
  /^\(([^()\s"]+?\.(?:tex|sty|cls|cfg|def|clo|fd|bbl|aux|toc|out|ltx|bib|dfu|code\.tex|lbx|cbx|bbx))/u;

/** 根据 `(file` / `)` 维护当前文件栈，返回每一行开头所在的文件 */
function trackFiles(lines: string[]): (string | null)[] {
  const stack: (string | null)[] = [];
  const at: (string | null)[] = [];
  for (const line of lines) {
    at.push(currentFile(stack));
    // 错误信息里的括号不算
    if (/^(?:! |l\.\d+ |LaTeX Warning|Package |Class |Overfull|Underfull)/u.test(line)) continue;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '(') {
        const m = FILE_TOKEN.exec(line.slice(i));
        if (m) {
          stack.push(normFile(m[1]!));
          i += m[0].length - 1;
        } else stack.push(null);
      } else if (ch === ')') {
        stack.pop();
      }
    }
  }
  return at;
}

function currentFile(stack: (string | null)[]): string | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const f = stack[i];
    if (f && /\.(?:tex|bbl|ltx)$/u.test(f)) return f;
  }
  return null;
}

/** 用户自己的文件（不是宏包内部） */
function userFile(file: string | null, projectFiles: readonly string[] | undefined): string | null {
  if (!file) return null;
  if (projectFiles && projectFiles.length > 0) {
    if (projectFiles.includes(file)) return file;
    const withTex = `${file}.tex`;
    if (projectFiles.includes(withTex)) return withTex;
    return null;
  }
  return /\.(?:tex|bib)$/u.test(file) ? file : null;
}

interface Translation {
  message: string;
  kind: TexIssueKind;
  fixable: boolean;
}

/** 常见错误的中文说明 */
export function translateError(msg: string, context: string): Translation {
  const m = msg.replace(/\.$/u, '').trim();
  if (/^Undefined control sequence/u.test(m)) {
    const cs = /(\\[A-Za-z@]+|\\.)\s*$/u.exec(context.trimEnd())?.[1];
    return {
      message: cs
        ? tr('未定义的命令 {cs}（拼写错误，或者忘了加载宏包）', { cs })
        : tr('使用了未定义的命令'),
      kind: 'undefined_control',
      fixable: true,
    };
  }
  if (/^Missing \$ inserted/u.test(m)) {
    return {
      message: tr('缺少 $：数学符号写在了公式外面，或者公式没有闭合'),
      kind: 'other',
      fixable: true,
    };
  }
  const file = /^(?:LaTeX Error: )?File `([^']+)' not found/u.exec(m);
  if (file) {
    return {
      message: tr('找不到文件 {value}（检查文件名，或者把它加到工程里）', { value: file[1] }),
      kind: 'missing_file',
      fixable: false,
    };
  }
  const env =
    /^LaTeX Error: \\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/u.exec(m);
  if (env) {
    return {
      message: tr('第 {value} 行的 \\begin{{value2}} 被 \\end{{value3}} 结束了：环境没有正确配对', {
        value: env[2],
        value2: env[1],
        value3: env[3],
      }),
      kind: 'other',
      fixable: true,
    };
  }
  if (/^LaTeX Error: Lonely \\item/u.test(m)) {
    return {
      message: tr('\\item 不在 itemize / enumerate 等列表环境里'),
      kind: 'other',
      fixable: true,
    };
  }
  const envUndef = /^LaTeX Error: Environment (\S+) undefined/u.exec(m);
  if (envUndef) {
    return {
      message: tr('未定义的环境 {value}（拼写错误，或者忘了加载宏包）', { value: envUndef[1] }),
      kind: 'undefined_control',
      fixable: true,
    };
  }
  if (/^Extra \}, or forgotten/u.test(m) || /^Missing \} inserted/u.test(m)) {
    return { message: tr('花括号不配对'), kind: 'other', fixable: true };
  }
  if (/^Too many \}'s/u.test(m)) return { message: tr('多余的 }'), kind: 'other', fixable: true };
  if (/^Misplaced alignment tab character &/u.test(m)) {
    return {
      message: tr('& 只能用在表格或对齐环境里（正文里写 \\&）'),
      kind: 'other',
      fixable: true,
    };
  }
  if (/^Emergency stop/u.test(m) || /^==> Fatal error occurred/u.test(m)) {
    return { message: tr('编译提前停止了（看上面的第一个错误）'), kind: 'other', fixable: false };
  }
  return { message: m.replace(/^LaTeX Error: /u, ''), kind: 'other', fixable: true };
}

function warningIssue(
  text: string,
  file: string | null,
  line: number | null,
  projectFiles: readonly string[] | undefined,
): TexIssue | null {
  const t = text.replace(/\s+/gu, ' ').trim();
  const lineNo = line ?? numberOrNull(/on input line (\d+)/u.exec(t)?.[1]);
  const uf = userFile(file, projectFiles);
  const cite = /Citation [`'"]([^'"`]+)['"`]/u.exec(t);
  if (cite && /undefined/u.test(t)) {
    return {
      severity: 'warning',
      file: uf,
      line: lineNo,
      message: tr('找不到参考文献 {value}（检查 \\cite 的 key 是否在 .bib 里）', {
        value: cite[1],
      }),
      kind: 'undefined_citation',
      fixable: false,
      raw: text,
    };
  }
  const ref = /Reference [`'"]([^'"`]+)['"`]/u.exec(t);
  if (ref && /undefined/u.test(t)) {
    return {
      severity: 'warning',
      file: uf,
      line: lineNo,
      message: tr('找不到标签 {value}（\\ref 引用了没有定义的 \\label）', { value: ref[1] }),
      kind: 'undefined_reference',
      fixable: true,
      raw: text,
    };
  }
  // 汇总性 / 会自动重跑的提示：不单独列出
  if (
    /There were undefined (?:references|citations)/u.test(t) ||
    /Label\(s\) may have changed/u.test(t) ||
    /Rerun to get/u.test(t) ||
    /^LaTeX Font Warning/u.test(t) ||
    /Font shape .* undefined/u.test(t) ||
    /Some font shapes were not available/u.test(t)
  ) {
    return null;
  }
  const float = /^LaTeX Warning: [`'](!?h)' float specifier changed to [`'](!?ht)'/u.exec(t);
  if (float) {
    return {
      severity: 'warning',
      file: uf,
      line: lineNo,
      message: tr(
        '有表格 / 图（[{value}]）在原位置放不下，被挪到了后面（通常是下一页顶部）。如果某一节只有浮动体，这一节在原来的页上会显得是空的：给这节加一句引导文字，或改成 [htbp] / 缩小图表',
        { value: float[1] },
      ),
      kind: 'other',
      fixable: false,
      raw: text,
    };
  }
  const empty = /Empty [`']?thebibliography'? environment/u.test(t);
  return {
    severity: 'warning',
    file: uf,
    line: lineNo,
    message: empty
      ? tr('参考文献列表是空的（没有任何 \\cite，或 .bib 文件里没有对应条目）')
      : t
          .replace(/^(?:LaTeX|Package \S+|Class \S+) Warning: /u, '')
          .replace(/\s*on input line \d+\.?$/u, ''),
    kind: empty ? 'missing_bib' : 'other',
    fixable: false,
    raw: text,
  };
}

function numberOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** BibTeX 日志（.blg）里的问题 */
function parseBibtex(lines: string[], projectFiles: readonly string[] | undefined): TexIssue[] {
  const out: TexIssue[] = [];
  const databases = lines
    .map((l) => /^Database file #\d+: (\S+)/u.exec(l)?.[1])
    .filter((x): x is string => !!x);
  // 一个 .bib 都没打开：后面每个 \cite 的 “didn't find a database entry” 都是连带后果，不逐条列
  const noDatabase =
    databases.length === 0 && lines.some((l) => /^I couldn't open database file /u.test(l));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const noEntry = /^Warning--I didn't find a database entry for "([^"]+)"/u.exec(line);
    if (noEntry) {
      if (noDatabase) continue;
      out.push({
        severity: 'warning',
        file: null,
        line: null,
        message: tr('{value} 里没有条目 {value2}', {
          value: databases.length === 1 ? databases[0] : '.bib',
          value2: noEntry[1],
        }),
        kind: 'undefined_citation',
        fixable: false,
        raw: line,
      });
      continue;
    }
    // “I couldn't open database file x.bib” 下一行的 “---line N of file main.aux” 只是位置，
    // 不是 .bib 语法错误（以前会被重复算成第二个错误）
    if (/^I found no database files/u.test(line)) continue;
    const noFile = /^I couldn't open (?:database|style) file (\S+)/u.exec(line);
    if (noFile) {
      out.push({
        severity: 'error',
        file: null,
        line: null,
        message: tr(
          'BibTeX 找不到文件 {value}（\\bibliography{…} 里的名字要和工程里的 .bib 文件一致）',
          { value: noFile[1] },
        ),
        kind: 'missing_bib',
        fixable: false,
        raw: line,
      });
      continue;
    }
    if (/^I found no \\bibdata command/u.test(line)) {
      out.push({
        severity: 'warning',
        file: null,
        line: null,
        message: tr('用了 \\cite 但没有 \\bibliography{…}，参考文献不会生成'),
        kind: 'missing_bib',
        fixable: false,
        raw: line,
      });
      continue;
    }
    if (/^I found no \\bibstyle command/u.test(line)) {
      out.push({
        severity: 'warning',
        file: null,
        line: null,
        message: tr('缺少 \\bibliographystyle{…}（例如 plain、unsrt）'),
        kind: 'missing_bib',
        fixable: true,
        raw: line,
      });
      continue;
    }
    // 语法错误：下一行（或同一行）是 "---line N of file x.bib"
    const at = /---line (\d+) of file (\S+)/u.exec(line);
    if (at && !/\.bib$/iu.test(at[2]!)) continue;
    if (at) {
      const prev = lines[i - 1] ?? '';
      const file = normFile(at[2]!);
      out.push({
        severity: 'error',
        file: projectFiles?.includes(file) || !projectFiles ? file : file,
        line: Number(at[1]),
        message: tr('.bib 语法错误：{value}', {
          value: prev.replace(/^I was expecting /u, tr('应为 ')).trim() || line,
        }),
        kind: 'bibtex',
        fixable: true,
        raw: `${prev}\n${line}`,
      });
      continue;
    }
    const warnLine = /^Warning--(.+)$/u.exec(line);
    if (warnLine) {
      const next = lines[i + 1] ?? '';
      const loc = /--line (\d+) of file (\S+)/u.exec(next);
      out.push({
        severity: 'warning',
        file: loc ? normFile(loc[2]!) : null,
        line: loc ? Number(loc[1]) : null,
        message: tr('BibTeX：{value}', { value: warnLine[1] }),
        kind: 'bibtex',
        fixable: false,
        raw: line,
      });
    }
  }
  return out;
}

export interface ParseTexLogOptions {
  /** 工程里的文件名：只把这些文件里的位置当作可跳转的位置 */
  projectFiles?: readonly string[];
}

export function parseTexLog(log: string, opts: ParseTexLogOptions = {}): TexIssue[] {
  const { projectFiles } = opts;
  const sections = log.split(/^---- /mu);
  const texPart = sections[0] ?? '';
  const issues: TexIssue[] = [];

  const lines = unwrapLog(texPart);
  const files = trackFiles(lines);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    // file:line: message（-file-line-error，或服务端拒绝编译时的说明）
    const fle = /^((?:\.\/)?[^\s:()]+\.(?:tex|sty|cls|bib)):(\d+): (.+)$/u.exec(line);
    if (fle) {
      const ctxLines = lines.slice(i + 1, i + 4).join('\n');
      const l = /^l\.\d+ (.*)$/mu.exec(ctxLines)?.[1] ?? '';
      const tr = translateError(fle[3]!, l);
      issues.push({
        severity: 'error',
        file: userFile(normFile(fle[1]!), projectFiles) ?? normFile(fle[1]!),
        line: Number(fle[2]),
        ...tr,
        raw: [line, ...lines.slice(i + 1, i + 3)].join('\n'),
      });
      continue;
    }

    if (line.startsWith('! ')) {
      // 往下找 l.<n>
      let lineNo: number | null = null;
      let context = '';
      let j = i + 1;
      for (; j < Math.min(lines.length, i + 12); j += 1) {
        const lm = /^l\.(\d+) ?(.*)$/u.exec(lines[j]!);
        if (lm) {
          lineNo = Number(lm[1]);
          context = lm[2] ?? '';
          break;
        }
        if (lines[j]!.startsWith('! ')) break;
      }
      const msg = line.slice(2);
      // 跟在前一个错误后面的连锁错误（Emergency stop 等）：如果没有行号就略过
      if (
        /^(?:Emergency stop|==> Fatal error occurred)/u.test(msg) &&
        issues.some((x) => x.severity === 'error')
      ) {
        continue;
      }
      const tr = translateError(msg, context);
      issues.push({
        severity: 'error',
        file: userFile(files[i] ?? null, projectFiles) ?? (lineNo !== null ? 'main.tex' : null),
        line: lineNo,
        ...tr,
        raw: lines.slice(i, Math.max(i + 1, j + 2)).join('\n'),
      });
      continue;
    }

    const warn = /^(LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/u.exec(line);
    if (warn) {
      const pkg = warn[2] ?? warn[3] ?? null;
      let text = line;
      // 续行：`(pkg)  ...`
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        if (pkg && next.startsWith(`(${pkg})`)) {
          text += ` ${next.slice(pkg.length + 2).trim()}`;
          j += 1;
        } else if (
          !pkg &&
          next.trim() &&
          !/^[!(\\]|^\s*$|Warning|^Overfull|^Underfull/u.test(next) &&
          j === i + 1 &&
          !/\.$/u.test(line)
        ) {
          text += ` ${next.trim()}`;
          j += 1;
        } else break;
      }
      const issue = warningIssue(text, files[i] ?? null, null, projectFiles);
      if (issue) issues.push(issue);
      continue;
    }

    const bad =
      /^(Overfull|Underfull) \\[hv]box \(([^)]*)\) (?:in paragraph |detected )?at lines? (\d+)/u.exec(
        line,
      );
    if (bad) {
      issues.push({
        severity: 'info',
        file: userFile(files[i] ?? null, projectFiles),
        line: Number(bad[3]),
        message: tr('{value}（{value2}）', {
          value: bad[1] === 'Overfull' ? tr('这一行排出了边界') : tr('这一行排得太松'),
          value2: bad[2],
        }),
        kind: 'badbox',
        fixable: false,
        raw: line,
      });
      continue;
    }

    if (/^No file main\.bbl/u.test(line)) continue;
  }

  for (const sec of sections.slice(1)) {
    const header = sec.split('\n', 1)[0] ?? '';
    const body = unwrapLog(sec.slice(header.length + 1));
    if (/BibTeX/u.test(header)) {
      issues.push(...parseBibtex(body, projectFiles));
    } else if (/编译器输出/u.test(header) && !issues.some((x) => x.severity === 'error')) {
      // TeX 日志里没解析出错误（例如没有生成 main.log）：退回到编译器输出里的 error: 行
      for (const l of body) {
        const m = /^error: (?:([^\s:]+\.tex):(\d+): )?(.+)$/u.exec(l);
        if (!m || /something bad happened|unrecoverable error|halted on/u.test(m[3]!)) continue;
        const tr = translateError(m[3]!, '');
        issues.push({
          severity: 'error',
          file: m[1] ? normFile(m[1]) : null,
          line: m[2] ? Number(m[2]) : null,
          ...tr,
          raw: l,
        });
      }
    }
  }

  // 研协自己的提示（缺图片、超时、PDF 过大……）
  const missingBibs: string[] = [];
  for (const l of log.split(/\r?\n/u)) {
    // 服务端 latex/service.ts MISSING_BIB_NOTE：\bibliography 引用的 .bib 不在工程里
    const bib = /^研协：参考文献库缺失：(\S+?) 第 (\d+) 行 .*? 要用 (\S+?\.bib)，/u.exec(l);
    if (bib) {
      missingBibs.push(bib[3]!);
      issues.push({
        severity: 'error',
        file: userFile(bib[1]!, projectFiles) ?? bib[1]!,
        line: Number(bib[2]),
        message: l.replace(/^研协：参考文献库缺失：\S+ 第 \d+ 行 /u, ''),
        kind: 'missing_bib',
        fixable: false,
        raw: l,
      });
      continue;
    }
    const m = /^研协：(.+)$/u.exec(l);
    if (m) {
      issues.push({
        severity: /超时|终止|超过上限/u.test(m[1]!) ? 'error' : 'warning',
        file: null,
        line: null,
        message: m[1]!,
        kind: /图片/u.test(m[1]!) ? 'missing_file' : 'other',
        fixable: false,
        raw: l,
      });
    }
  }

  return dedupe(missingBibs.length > 0 ? explainMissingBib(issues, missingBibs) : issues);
}

/**
 * 服务端已经说明了哪个 .bib 不在工程里：BibTeX 的 “找不到文件” 不再重复算一个错误，
 * 各处 “找不到参考文献 X” 改成指向真正原因（不是 key 拼错）。
 */
function explainMissingBib(issues: TexIssue[], missing: string[]): TexIssue[] {
  const names = missing.join(tr('、'));
  return issues
    .filter(
      (it) =>
        !(
          it.kind === 'missing_bib' &&
          it.severity === 'error' &&
          /^I couldn't open database file /u.test(it.raw) &&
          missing.some((n) => it.raw.endsWith(n))
        ),
    )
    .map((it) =>
      it.kind === 'undefined_citation'
        ? {
            ...it,
            message: it.message.replace(
              /（[^）]*）$/u,
              tr('（{names} 不在工程里，见上面的错误）', { names }),
            ),
          }
        : it,
    );
}

function dedupe(list: TexIssue[]): TexIssue[] {
  const seen = new Set<string>();
  const out: TexIssue[] = [];
  for (const it of list) {
    const key = `${it.severity}|${it.file}|${it.line}|${it.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  // 错误在前；同级按出现顺序（稳定排序）
  return out
    .map((it, i) => ({ it, i }))
    .sort((a, b) => rank[a.it.severity] - rank[b.it.severity] || a.i - b.i)
    .map((x) => x.it);
}

/**
 * 编译失败（没有 PDF / 超时 / 被拒绝）但日志里没解析出任何错误时（例如 xdvipdfmx 读图片出错），
 * 补一条总的错误，免得问题面板显示“无问题”。
 */
export function withFailureIssue(
  issues: TexIssue[],
  status: string,
  log: string,
  hasPdf: boolean,
): TexIssue[] {
  if (issues.some((i) => i.severity === 'error')) return issues;
  if (status === 'success' || (status === 'error' && hasPdf)) return issues;
  const compilerOut = log.split(/^---- 编译器输出[^\n]*\n/mu)[1] ?? '';
  const last = compilerOut
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => /error|错误|failed|失败/iu.test(l) && !/^warning:/u.test(l))
    .filter((l) => !/something bad happened|unrecoverable error|halted on/u.test(l))
    .pop();
  const lib = last ? /^lib(?:png|jpeg)\b/u.test(last) : false;
  return [
    {
      severity: 'error',
      file: null,
      line: null,
      message: lib
        ? tr('图片文件损坏或格式不对（{last}），换一张图片再试', { last })
        : last
          ? tr('编译失败：{last}', { last: last.replace(/^error:\s*/u, '') })
          : tr('编译失败，没有生成 PDF（详情见原始日志）'),
      kind: lib ? 'missing_file' : 'other',
      fixable: false,
      raw: last ?? '',
    },
    ...issues,
  ];
}

export function issueCounts(list: TexIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const it of list) {
    if (it.severity === 'error') errors += 1;
    else if (it.severity === 'warning') warnings += 1;
  }
  return { errors, warnings };
}
