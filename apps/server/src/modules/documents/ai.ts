import type { DocumentAiAction, DocumentKind } from '@srh/shared';

/**
 * 文档内嵌 AI 的提示词（POST P/docs/:docId/ai，流式纯文本）。
 * 输出格式按编辑器约定（见 apps/web/src/features/docs/editors/*）：
 * - doc：markdown 片段；sheet 的 table：CSV；slides：以 `## 标题` 分页的 markdown；latex：LaTeX 片段
 */
const BASE = [
  '你是「研协」科研协作平台里嵌在文档编辑器中的写作助手，服务对象是高校课题组与研究团队。',
  '规则：',
  '- 只输出要放进文档的内容本身，不要寒暄、解释、前言或结束语，不要用 ``` 代码围栏包住整个输出。',
  '- 默认用简体中文写作；专业术语、模型名、数据集名、公式保持原样。',
  '- 不编造实验数字、引用文献或作者；需要数据但上下文没有时，用「（待补充）」占位。',
  '- 保持学术、准确、简洁的语气。',
].join('\n');

const FORMAT: Record<DocumentKind, string> = {
  doc: '输出格式：Markdown（可用标题、列表、表格、`$行内公式$`、`$$块公式$$`）。',
  sheet: '输出格式：纯文本。',
  slides: '输出格式：Markdown。',
  latex:
    '输出格式：LaTeX 源码片段。不要新增 \\documentclass、导言区或 \\begin{document}；但选中内容里原有的这些结构命令要原样保留。保留原有命令、\\label、\\cite 与公式。',
};

/** latex_fix 的输出格式：输出会原样替换掉给出的那几行 */
const LATEX_FIX_FORMAT = [
  '输出格式：只输出用来替换 <snippet> 那几行的 LaTeX 源码，不带行号前缀、不带 ``` 围栏、不加任何解释。',
  '- 你的输出会原样替换掉 <snippet> 标出的行范围，范围外的内容不会被改动，也不要输出范围外的内容。',
  '- 片段里已有的 \\documentclass、\\usepackage、\\title、\\author、\\begin{document}、\\end{document}、\\bibliography、\\input 等导言区与结构命令必须原样保留（除非错误就出在它们自己身上），不得删除或改写。',
  '- 只改和报告的问题有关的地方，其余行一字不改；不要新增宏包或删掉正文。',
].join('\n');

const ACTION: Record<DocumentAiAction, string> = {
  continue:
    '接着往下写一到三段：<selection> 是光标前的文字（没有时接在 <document> 末尾），衔接自然，不要重复已有内容。只输出新写的部分。',
  polish: '润色用户选中的文字：修正语病、使表达更通顺专业，不改变原意与结构。只输出润色后的文字。',
  shorten: '精简用户选中的文字，保留核心信息，篇幅压到原来的一半左右。只输出精简后的文字。',
  expand: '扩写用户选中的文字，补充论证、细节或例子，篇幅约为原来的两倍。只输出扩写后的文字。',
  translate_en: '把用户选中的文字翻译成地道的学术英文。只输出译文。',
  translate_zh: '把用户选中的文字翻译成流畅的中文。只输出译文。',
  summarize: '总结给出的内容，先一句话概括，再用 3–6 条要点列出关键信息。',
  academic: '把用户选中的文字改写成适合论文的正式学术语气。只输出改写后的文字。',
  custom: '按用户的指令处理选中的文字（没有选中文字时，按指令生成新内容）。只输出结果。',
  outline: '根据主题与文档已有内容，生成一份层次清晰的大纲（二、三级标题加简短要点）。',
  table:
    '根据用户的要求生成一张表格，输出 CSV：第一行是表头，逗号分隔，含逗号或换行的单元格用双引号包住。只输出 CSV，不要任何其他文字。',
  slides:
    '根据用户的要求写一份幻灯片。每页以 `## 页标题` 开头，正文用 `- ` 要点（每页 3–5 条，每条不超过 25 字）；第一页是封面，只写标题和一行副标题；演讲者备注写在以 `> ` 开头的行里。默认 6–10 页。只输出幻灯片 markdown。',
  latex_fix:
    '<snippet> 是一段有问题的 LaTeX 源码（每行前面标了在文件里的行号），后面附有编译 / 预览报出的问题。修正它（未闭合的环境、括号、错误命令、公式语法、导言区里误放的正文），尽量少改动。只输出修正后的那段源码。',
  latex_section:
    '按用户给的主题写一个完整的 LaTeX 小节：\\section{…} 开头，内容充实、逻辑清楚，需要时使用 equation、itemize，引用写成 \\cite{待补充} 形式。只输出这一节的源码。',
};

export function aiSystemPrompt(kind: DocumentKind, action: DocumentAiAction): string {
  const format =
    action === 'table'
      ? '输出格式：CSV。'
      : action === 'slides'
        ? 'Markdown 幻灯片。'
        : action === 'latex_fix'
          ? LATEX_FIX_FORMAT
          : FORMAT[kind];
  return `${BASE}\n\n任务：${ACTION[action]}\n${format}`;
}

const SELECTION_ACTIONS = new Set<DocumentAiAction>([
  'polish',
  'shorten',
  'expand',
  'translate_en',
  'translate_zh',
  'academic',
  'latex_fix',
]);

export function needsSelection(action: DocumentAiAction): boolean {
  return SELECTION_ACTIONS.has(action);
}

export function aiUserPrompt(input: {
  title: string;
  kind: DocumentKind;
  action: DocumentAiAction;
  selection: string;
  prompt: string;
  context: string;
}): string {
  const parts = [`文档标题：${input.title}`];
  const ctx = input.context.trim();
  if (ctx) {
    const clipped = ctx.length > 12_000 ? `…${ctx.slice(-12_000)}` : ctx;
    parts.push(`<document>\n${clipped}\n</document>`);
  }
  if (input.selection.trim()) parts.push(`<selection>\n${input.selection}\n</selection>`);
  if (input.prompt.trim()) parts.push(`用户的要求：${input.prompt.trim()}`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- LaTeX 修复

/** readDocument 给多文件 latex 工程加在开头的文件清单注释（latex/project.ts latexFilesComment），算行号前去掉 */
export function stripLatexFilesComment(markdown: string): string {
  if (!markdown.startsWith('% ---- 工程文件')) return markdown;
  const marker = '\n% ----\n';
  const end = markdown.indexOf(marker);
  return end < 0 ? markdown : markdown.slice(end + marker.length);
}

/** 前端在 prompt 里写明片段从第几行开始（「片段起始行：12」） */
const START_LINE_RE = /片段起始行[:：]\s*(\d+)/u;
/** 导言区最多原样给出这么多行，再长只列结构命令 */
const MAX_PREAMBLE_LINES = 200;
const STRUCTURAL_ISSUE_RE =
  /Missing \\begin\{document\}|before \\documentclass|\\documentclass|only in preamble|font size command \\normalsize|导言区/u;
const STRUCTURE_CMD_RE =
  /\\(?:documentclass|usepackage|RequirePackage|title|author|date|begin\s*\{document\}|input|include)(?![A-Za-z@])/u;

function stripTexComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

function numberLines(lines: readonly string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width, ' ')}| ${l}`).join('\n');
}

function findLine(lines: readonly string[], re: RegExp): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(stripTexComment(lines[i] as string))) return i + 1;
  }
  return null;
}

/**
 * latex_fix 的用户提示词：片段带上在文件里的行号；附上主文件从 \documentclass 到 \begin{document}
 * 的导言区结构（只读参考），并写明「输出会原样替换第 a–b 行，范围外不得输出 / 改写，导言区原样保留」。
 * 终验缺陷 #9：只给 ±15 行、又在格式要求里写「不要包含 \documentclass」，模型就把第 1 行的 \documentclass 删了。
 */
export function latexFixUserPrompt(input: {
  title: string;
  selection: string;
  prompt: string;
  /** 主文件源码（readDocument 的 markdown，可带文件清单注释） */
  document: string;
}): string {
  const doc = stripLatexFilesComment(input.document).replace(/\r\n?/gu, '\n');
  const sel = input.selection.replace(/\r\n?/gu, '\n');
  const docLines = doc.split('\n');
  const selLines = sel.split('\n');

  // 片段在主文件里的起始行：优先用前端给的行号核对，其次按内容查找
  const hintMatch = START_LINE_RE.exec(input.prompt);
  const hint = hintMatch ? Number(hintMatch[1]) : null;
  let start: number | null = null;
  let inMain = false;
  if (hint && docLines.slice(hint - 1, hint - 1 + selLines.length).join('\n') === sel) {
    start = hint;
    inMain = true;
  } else if (sel.trim()) {
    const at = doc.indexOf(sel);
    if (at >= 0) {
      start = doc.slice(0, at).split('\n').length;
      inMain = true;
    }
  }
  start ??= hint ?? 1;
  const end = start + selLines.length - 1;
  const range = start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
  const request = input.prompt
    .replace(START_LINE_RE, '')
    .replace(/[（(]\s*[)）]/gu, '')
    .trim();

  const parts = [`文档标题：${input.title}`];

  // 文档结构：导言区到 \begin{document}
  if (doc.trim()) {
    const begin = findLine(docLines, /\\begin\s*\{document\}/u);
    const endDoc = findLine(docLines, /\\end\s*\{document\}/u);
    const head = inMain
      ? '主文件的结构'
      : '主文件 main.tex 的结构（片段来自工程里的另一个文件，这里只供参考）';
    const facts = [
      begin ? `\\begin{document} 在第 ${begin} 行` : '全文没有找到 \\begin{document}',
      endDoc ? `\\end{document} 在第 ${endDoc} 行` : '全文没有找到 \\end{document}',
      `全文共 ${docLines.length} 行`,
    ].join('；');
    const preambleEnd = begin ?? Math.min(docLines.length, MAX_PREAMBLE_LINES);
    const preamble = docLines.slice(0, preambleEnd);
    let shown: string;
    if (preamble.length <= MAX_PREAMBLE_LINES) {
      shown = numberLines(preamble, 1);
    } else {
      shown = preamble
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => STRUCTURE_CMD_RE.test(stripTexComment(l)))
        .map(({ l, n }) => `${n}| ${l}`)
        .join('\n');
    }
    parts.push(
      `${head}：${facts}。下面是从第 1 行到 \\begin{document} 的导言区（只读参考，行号是文件里的行号）：\n<preamble>\n${shown}\n</preamble>`,
    );
  }

  parts.push(`<snippet range="${range}">\n${numberLines(selLines, start)}\n</snippet>`);
  if (request) parts.push(`报告的问题：${request}`);

  const rules = [
    `请输出替换${range}的完整内容（原来共 ${selLines.length} 行），不要带行号前缀。`,
    `- 不得删除或改写${range}以外的内容，也不要把范围外的行写进输出。`,
    '- 原样保留片段里的 \\documentclass、\\usepackage 等导言区命令，以及 \\begin{document}、\\end{document}、\\bibliography、\\input、\\label、\\cite；与问题无关的行一字不改。',
  ];
  const structural =
    STRUCTURAL_ISSUE_RE.test(input.prompt) ||
    selLines.some((l) => /\\documentclass(?![A-Za-z@])/u.test(stripTexComment(l)));
  if (structural) {
    rules.push(
      '- 结构要求：\\documentclass 必须是第一条命令；导言区（\\documentclass 与 \\begin{document} 之间）只能放 \\usepackage、\\title、\\author 这类设置。误放在导言区的正文要整行移到 \\begin{document} 之后（\\maketitle 之后的合适位置），或在明显是误输入时删掉；绝不能删掉 \\documentclass 或导言区里的其他行。',
    );
  }
  parts.push(rules.join('\n'));
  return parts.join('\n\n');
}

/** 去掉模型偶尔加上的整体 ``` 围栏（流式场景只处理开头） */
export function stripLeadingFence(text: string): string {
  return text.replace(/^\s*```[a-zA-Z]*\n/u, '');
}
