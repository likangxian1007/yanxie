import type { AgentStep } from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * agent 每一步 → 给人看的一句中文（思路页、产出与改动页用）。
 * 工具名、英文参数和原始 JSON 不出现在默认视图里，只放进「原始数据」折叠块。
 * 每个服务端注册的工具（apps/server/src/agents/tools、harness）都在 TOOLS 里有一条；
 * 没收录的工具（新工具、MCP 工具）走兜底，同样不会把 JSON 摆出来。
 */

type Rec = Record<string, unknown>;

export interface SummaryContext {
  /** 文档 id → 标题（参数里只有 doc_id 时用项目文档列表补标题） */
  docTitle?: ((id: string) => string | undefined) | undefined;
}

/** 一次工具调用：调用 + 配对的结果（结果可能还没到） */
export interface ToolCall {
  name: string;
  call: AgentStep | null;
  result: AgentStep | null;
  args: Rec | null;
  /** 解析后的结果；不是 JSON 时为 null（原文在 result.content） */
  output: Rec | null;
  /** true 成功 / false 失败 / null 还没结果 */
  ok: boolean | null;
}

export type Tone = 'success' | 'error' | 'neutral';

export interface CallSummary {
  /** 一句话：做了什么（「读了文档《开题报告》」） */
  text: string;
  /** 结果怎样（「找到 8 条结果」「没成功：……」）；没什么可说时为 null */
  outcome: string | null;
  tone: Tone;
  /** 改动规模（「+12 行」「−3 字 +5 字」），只有写入类工具有 */
  diff: string | null;
}

// ---------------------------------------------------------------- 小工具

export function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRec(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}

function str(r: Rec | null | undefined, key: string): string | null {
  const v = r?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(r: Rec | null | undefined, key: string): number | null {
  const v = r?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function arr(r: Rec | null | undefined, key: string): unknown[] | null {
  const v = r?.[key];
  return Array.isArray(v) ? v : null;
}

/** 截成一行短摘录 */
export function clip(text: string, max = 40): string {
  const one = text.replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 检索式：字符串或一组字符串 → 「a；b」 */
function queries(r: Rec | null): string | null {
  const q = r?.query;
  if (typeof q === 'string' && q.trim()) return clip(q, 60);
  if (Array.isArray(q)) {
    const list = q.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (list.length) return clip(list.join(tr('；')), 60);
  }
  return null;
}

/** markdown 链接 `[标题](#id)` 里的标题 */
function linkTitle(r: Rec | null): string | null {
  const link = str(r, 'link');
  const m = link ? /^\[([^\]]+)\]/u.exec(link) : null;
  return m?.[1]?.trim() || null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return clip(url, 40);
  }
}

function lineCount(text: string | null): number {
  if (!text) return 0;
  return text.split(/\r?\n/u).filter((l) => l.trim()).length;
}

function charCount(text: string | null): number {
  return text ? [...text].length : 0;
}

/** 失败时的原因：结果里的 error 字段，或原文第一行；绝不返回 JSON */
export function errorReason(c: Pick<ToolCall, 'output' | 'result'>): string {
  const msg = str(c.output, 'error');
  if (msg) return clip(msg, 80);
  const raw = c.result?.content.trim() ?? '';
  if (!raw || raw.startsWith('{') || raw.startsWith('[')) return tr('原因见原始数据');
  return clip(raw.split('\n')[0] ?? '', 80);
}

const DOC_KIND_NAME: Record<string, string> = {
  doc: tr('文档'),
  sheet: tr('表格'),
  slides: tr('幻灯片'),
  latex: tr('LaTeX 文档'),
};

function docTitleOf(c: ToolCall, ctx: SummaryContext): string | null {
  const meta = asRec(c.output?.meta);
  const id = str(c.args, 'doc_id');
  return (
    str(c.output, 'title') ??
    str(meta, 'title') ??
    str(c.args, 'title') ??
    (id ? ctx.docTitle?.(id) : undefined) ??
    null
  );
}

function docName(c: ToolCall, ctx: SummaryContext): string {
  const title = docTitleOf(c, ctx);
  return title ? tr('《{title}》', { title }) : tr('一份文档');
}

/** 「前缀 + 值」，值为空时用兜底整句 */
function tail(prefix: string, value: string | null | undefined, fallback: string): string {
  return value ? `${prefix}${value}` : fallback;
}

function quoteName(name: string | null, fallback: string): string {
  return name ? tr('「{name}」', { name }) : fallback;
}

/** 认领的对象：doc_x#标题 → 《文档》的「标题」一节；doc_x → 《文档》；其余按类型说 */
function resourceName(kind: string | null, ref: string | null, ctx: SummaryContext): string {
  if (!ref) return tr('一项资源');
  if (ref.startsWith('doc_')) {
    const [id, heading] = ref.split('#', 2) as [string, string | undefined];
    const title = ctx.docTitle?.(id);
    const doc = title ? tr('《{title}》', { title }) : tr('一份文档');
    return heading ? tr('{doc}的「{heading}」一节', { doc, heading }) : doc;
  }
  if (kind === 'file') return tr('文件 {value}', { value: clip(ref, 40) });
  if (kind === 'experiment' || ref.startsWith('exp_')) return tr('一条实验记录');
  if (kind === 'card' || ref.startsWith('crd_')) return tr('一张看板卡片');
  if (kind === 'topic') return tr('「{value}」', { value: clip(ref, 30) });
  return tr('一项资源');
}

const EXPERIMENT_FIELD: Record<string, string> = {
  title: tr('标题'),
  hypothesis: tr('假设'),
  setup: tr('设置'),
  status: tr('状态'),
  metrics: tr('指标'),
  conclusion: tr('结论'),
  tags: tr('标签'),
};

const SEARCH_SOURCE: Record<string, string> = {
  openalex: 'OpenAlex',
  semantic_scholar: 'Semantic Scholar',
  crossref: 'Crossref',
  arxiv: 'arXiv',
};

const SCROLL_DIR: Record<string, string> = {
  up: tr('上'),
  down: tr('下'),
  left: tr('左'),
  right: tr('右'),
};

function count(c: ToolCall, key: string, unit: string): string | null {
  const list = arr(c.output, key);
  if (!list) return null;
  return list.length
    ? `${list.length} ${unit}`
    : tr('没有{unit}', { unit: unit.replace(/^[个条份篇段项张]/u, '') });
}

// ---------------------------------------------------------------- 每个工具

interface ToolSpec {
  /** 动作名（分组标题、兜底） */
  label: string;
  /** 会改动东西（产出与改动页的「改动」列表） */
  change?: boolean;
  /** 连续几次调用合并成一组时用的组名（默认工具名） */
  group?: string;
  say: (c: ToolCall, ctx: SummaryContext) => string;
  /** 成功时的结果摘要 */
  outcome?: (c: ToolCall, ctx: SummaryContext) => string | null;
  diff?: (c: ToolCall) => string | null;
}

const COMPUTER = 'computer';

const TOOLS: Record<string, ToolSpec> = {
  // ---- 进度与线程
  update_status: {
    label: tr('更新计划'),
    say: (c) => (c.args?.start_new === true ? tr('列出了新的计划') : tr('更新了计划')),
  },
  set_thread_label: {
    label: tr('设置线程标签'),
    say: (c) => {
      const l = str(c.args, 'label');
      return l ? tr('把线程标签设为「{l}」', { l }) : tr('清除了线程标签');
    },
  },
  set_thread_resolved: {
    label: tr('标记线程'),
    say: (c) => (c.args?.resolved === false ? tr('重新打开了线程') : tr('把线程标记为已解决')),
  },
  start_thread: {
    label: tr('开新线程'),
    say: (c) => tr('开了新线程{value}', { value: quoteName(str(c.args, 'title'), '') }),
    outcome: (c) => (c.output?.already_running === true ? tr('这件事已经有线程在做了') : null),
  },
  message_thread: {
    label: tr('给线程留言'),
    say: (c) => tr('给线程{value}留了言', { value: quoteName(linkTitle(c.output), '') }),
  },
  list_threads: {
    label: tr('查看线程列表'),
    say: () => tr('查看了线程列表'),
    outcome: (c) => count(c, 'threads', tr('个线程')),
  },
  fetch_thread: {
    label: tr('读线程'),
    say: (c) =>
      tr('读了线程{value}', { value: quoteName(str(asRec(c.output?.thread), 'title'), '') }),
    outcome: (c) => count(c, 'messages', tr('条消息')),
  },
  fetch_messages: {
    label: tr('读消息'),
    say: (c) => {
      const n = arr(c.args, 'message_ids')?.length ?? 0;
      return n > 1 ? tr('读了 {n} 条消息', { n }) : tr('读了一条消息');
    },
  },
  fetch_timeline: {
    label: tr('翻看协作台'),
    say: () => tr('翻看了协作台的消息'),
    outcome: (c) => count(c, 'messages', tr('条消息')),
  },
  send_to_coordinator: {
    label: tr('交给协调者'),
    say: (c) => {
      const t = str(c.args, 'text');
      return t ? tr('告诉协调者：{value}', { value: clip(t) }) : tr('把情况交给了协调者');
    },
  },
  // ---- 对话
  reply: {
    label: tr('回复'),
    say: (c) => {
      const b = str(c.args, 'body');
      return b ? tr('回复：{value}', { value: clip(b) }) : tr('回复了消息');
    },
  },
  post_message: {
    label: tr('发消息'),
    say: (c) => {
      const b = str(c.args, 'body');
      return b ? tr('发了一条消息：{value}', { value: clip(b) }) : tr('发了一条消息');
    },
  },
  update_message: { label: tr('修改消息'), say: () => tr('修改了自己的一条消息') },
  react: {
    label: tr('表情回应'),
    say: (c) => tr('加了表情回应 {value}', { value: str(c.args, 'emoji') ?? '' }).trim(),
  },
  unreact: {
    label: tr('撤回表情回应'),
    say: (c) => tr('撤回了表情回应 {value}', { value: str(c.args, 'emoji') ?? '' }).trim(),
  },
  no_reply_needed: { label: tr('不用回复'), say: () => tr('判断这次不需要回复') },
  ask_decision: {
    label: tr('请人拍板'),
    say: (c) => {
      const q = str(c.args, 'question');
      return q ? tr('请人拍板：{value}', { value: clip(q, 50) }) : tr('请人拍板');
    },
  },
  close_decision: { label: tr('关闭决策'), say: () => tr('关闭了一张决策卡') },
  request_review: {
    label: tr('请人审阅'),
    change: true,
    say: (c) => tr('请人审阅{value}', { value: quoteName(str(c.args, 'title'), '') }),
    outcome: (c) => (arr(c.output, 'superseded_reviews')?.length ? tr('旧的审阅已关闭') : null),
  },
  // ---- 认领
  claim: {
    label: tr('认领'),
    group: 'claims',
    say: (c, ctx) =>
      tr('认领了{value}', {
        value: resourceName(str(c.args, 'resource_kind'), str(c.args, 'resource_ref'), ctx),
      }),
    outcome: (c) =>
      c.output?.claim_conflict === true ? tr('和别人的认领重叠，没认领上，在排队等') : null,
  },
  renew_claim: { label: tr('续期认领'), group: 'claims', say: () => tr('续期了一项认领') },
  release_claim: { label: tr('释放认领'), group: 'claims', say: () => tr('释放了一项认领') },
  list_claims: {
    label: tr('查看认领'),
    group: 'claims',
    say: () => tr('查看了当前的认领'),
    outcome: (c) => count(c, 'claims', tr('项认领')),
  },
  check_conflicts: {
    label: tr('检查冲突'),
    group: 'claims',
    say: () => tr('检查了要改的地方有没有人占着'),
    outcome: (c) =>
      c.output?.clear === true
        ? tr('没有冲突')
        : arr(c.output, 'conflicts')
          ? tr('{count} 处冲突', { count: arr(c.output, 'conflicts')!.length })
          : null,
  },
  // ---- 文档
  list_documents: {
    label: tr('查看文档列表'),
    say: () => tr('查看了文档列表'),
    outcome: (c) => count(c, 'documents', tr('份文档')),
  },
  read_document: {
    label: tr('读文档'),
    say: (c, ctx) => {
      const sec = str(c.args, 'section');
      if (sec) return tr('读了{value}的「{sec}」一节', { value: docName(c, ctx), sec });
      const title = docTitleOf(c, ctx);
      return title ? tr('读了文档《{title}》', { title }) : tr('读了一份文档');
    },
  },
  create_document: {
    label: tr('新建文档'),
    change: true,
    say: (c, ctx) => {
      const kind = DOC_KIND_NAME[str(c.args, 'kind') ?? 'doc'] ?? tr('文档');
      const title = docTitleOf(c, ctx);
      return title
        ? tr('新建了{kind}《{title}》', { kind, title })
        : tr('新建了一份{kind}', { kind });
    },
    diff: (c) => {
      const n = lineCount(str(c.args, 'markdown'));
      return n ? tr('+{n} 行', { n }) : null;
    },
  },
  edit_document: {
    label: tr('编辑文档'),
    change: true,
    say: (c, ctx) => {
      const doc = docName(c, ctx);
      const h = str(c.args, 'heading');
      switch (str(c.args, 'op')) {
        case 'append':
          return tr('在{doc}末尾加了内容', { doc });
        case 'insert_after_heading':
          return h
            ? tr('在{doc}的「{h}」下面插入了内容', { doc, h })
            : tr('在{doc}里插入了内容', { doc });
        case 'replace_section':
          return h ? tr('改写了{doc}的「{h}」一节', { doc, h }) : tr('改写了{doc}的一节', { doc });
        case 'replace_text':
          return h
            ? tr('改了{doc}「{h}」里的一处文字', { doc, h })
            : tr('改了{doc}里的一处文字', { doc });
        case 'set_cells': {
          const n = arr(c.args, 'cells')?.length ?? 0;
          return tr('改了表格{doc}的 {n} 个单元格', { doc, n });
        }
        case 'append_slides':
          return tr('给{doc}加了 {value} 页幻灯片', {
            doc,
            value: arr(c.args, 'slides')?.length ?? 0,
          });
        case 'replace_slides':
          return tr('重写了{doc}的幻灯片（{value} 页）', {
            doc,
            value: arr(c.args, 'slides')?.length ?? 0,
          });
        default:
          return tr('编辑了{doc}', { doc });
      }
    },
    diff: (c) => {
      switch (str(c.args, 'op')) {
        case 'append':
        case 'insert_after_heading':
          return tr('+{value} 行', { value: lineCount(str(c.args, 'markdown')) });
        case 'replace_section':
          return tr('整节替换为 {value} 行', { value: lineCount(str(c.args, 'markdown')) });
        case 'replace_text': {
          const del = charCount(str(c.args, 'find'));
          const add = charCount(typeof c.args?.replace === 'string' ? c.args.replace : '');
          return tr('−{del} 字 +{add} 字', { del, add });
        }
        case 'set_cells':
          return tr('{value} 个单元格', { value: arr(c.args, 'cells')?.length ?? 0 });
        case 'append_slides':
        case 'replace_slides':
          return tr('{value} 页', { value: arr(c.args, 'slides')?.length ?? 0 });
        default:
          return null;
      }
    },
  },
  // ---- 文件
  list_files: {
    label: tr('查看文件列表'),
    say: (c) => {
      const dir = str(c.args, 'dir');
      return dir ? tr('查看了 {dir} 下的文件', { dir }) : tr('查看了项目文件列表');
    },
    outcome: (c) => count(c, 'files', tr('个文件')),
  },
  read_file: {
    label: tr('读文件'),
    say: (c) => {
      const path = str(c.output, 'path') ?? str(c.args, 'path_or_id');
      return tail(tr('读了文件 '), path && clip(path, 50), tr('读了一个文件'));
    },
  },
  write_file: {
    label: tr('写文件'),
    change: true,
    say: (c) => {
      const raw = str(c.output, 'path') ?? str(c.args, 'path');
      const path = raw && clip(raw, 50);
      if (c.output?.created === false) return tail(tr('覆盖了文件 '), path, tr('覆盖了一个文件'));
      return tail(tr('写了文件 '), path, tr('写了一个文件'));
    },
    diff: (c) => {
      const n = lineCount(str(c.args, 'content'));
      return n ? tr('{n} 行', { n }) : null;
    },
  },
  search_project: {
    label: tr('搜索项目'),
    say: (c) => {
      const q = str(c.args, 'query');
      return q ? tr('在项目里搜索「{value}」', { value: clip(q, 30) }) : tr('在项目里搜索');
    },
    outcome: (c) => {
      const n = ['threads', 'messages', 'memory', 'documents'].reduce(
        (sum, k) => sum + (arr(c.output, k)?.length ?? 0),
        0,
      );
      return c.output ? (n ? tr('找到 {n} 处', { n }) : tr('没有找到')) : null;
    },
  },
  // ---- 实验
  list_experiments: {
    label: tr('查看实验列表'),
    say: () => tr('查看了实验记录列表'),
    outcome: (c) => count(c, 'experiments', tr('条实验记录')),
  },
  read_experiment: {
    label: tr('读实验记录'),
    say: (c) =>
      tr('读了实验记录{value}', {
        value: quoteName(str(asRec(c.output?.experiment), 'title'), ''),
      }),
    outcome: (c) => count(c, 'logs', tr('条运行日志')),
  },
  create_experiment: {
    label: tr('新建实验'),
    change: true,
    say: (c) => tr('新建了实验记录{value}', { value: quoteName(str(c.args, 'title'), '') }),
  },
  update_experiment: {
    label: tr('更新实验'),
    change: true,
    say: (c) => {
      const fields = Object.keys(EXPERIMENT_FIELD)
        .filter((k) => c.args?.[k] !== undefined)
        .map((k) => EXPERIMENT_FIELD[k]);
      return fields.length
        ? tr('更新了实验记录的{fields}', { fields: fields.join(tr('、')) })
        : tr('更新了实验记录');
    },
  },
  log_experiment: {
    label: tr('记录实验日志'),
    change: true,
    say: () => tr('给实验记录追加了一条运行日志'),
    diff: (c) => {
      const n = lineCount(str(c.args, 'body'));
      return n ? tr('{n} 行', { n }) : null;
    },
  },
  // ---- 看板、待办、汇报
  create_card: {
    label: tr('新建看板卡片'),
    change: true,
    say: (c) => tr('在看板上建了卡片{value}', { value: quoteName(str(c.args, 'title'), '') }),
  },
  update_card: {
    label: tr('更新看板卡片'),
    change: true,
    say: (c) =>
      str(c.args, 'column_id') && Object.keys(c.args ?? {}).length <= 3
        ? tr('把一张看板卡片移到了另一列')
        : tr('更新了一张看板卡片'),
  },
  create_todo: {
    label: tr('新建待办'),
    change: true,
    say: (c) => tr('建了待办{value}', { value: quoteName(str(c.args, 'title'), '') }),
  },
  draft_report: {
    label: tr('起草组会汇报'),
    change: true,
    say: (c) => {
      const a = str(c.args, 'period_start');
      const b = str(c.args, 'period_end');
      return a && b ? tr('起草了组会汇报（{a} 至 {b}）', { a, b }) : tr('起草了组会汇报');
    },
  },
  // ---- 成员与记忆
  list_members: { label: tr('查看成员'), say: () => tr('查看了成员名单') },
  memory_list: {
    label: tr('查看项目记忆'),
    group: 'memory',
    say: () => tr('查看了项目记忆'),
    outcome: (c) => count(c, 'files', tr('份记忆')),
  },
  memory_read: {
    label: tr('读项目记忆'),
    group: 'memory',
    say: (c) => tr('读了项目记忆 {value}', { value: str(c.args, 'path') ?? '' }).trim(),
  },
  memory_write: {
    label: tr('写项目记忆'),
    change: true,
    say: (c) => tr('更新了项目记忆 {value}', { value: str(c.args, 'path') ?? '' }).trim(),
    outcome: (c) => (c.output?.ok === false ? tr('版本过期，没写进去') : null),
    diff: (c) => {
      const n = lineCount(str(c.args, 'content'));
      return n ? tr('{n} 行', { n }) : null;
    },
  },
  // ---- 联网
  web_search: {
    label: tr('联网搜索'),
    say: (c) => tail(tr('联网搜索：'), queries(c.args), tr('联网搜索')),
    outcome: (c) => count(c, 'results', tr('条结果')),
  },
  paper_search: {
    label: tr('检索论文'),
    say: (c) => {
      const src = arr(c.args, 'sources')?.filter((s): s is string => typeof s === 'string');
      const where =
        src && src.length > 0 && src.length < 4
          ? src.map((s) => SEARCH_SOURCE[s] ?? s).join(tr('、'))
          : tr('论文库');
      // 中文和拉丁字母之间留半角空格
      const w = /^[A-Za-z]/u.test(where) ? ` ${where}` : where;
      return tail(tr('搜索了{w}：', { w }), queries(c.args), tr('搜索了{w}', { w }));
    },
    outcome: (c) => count(c, 'results', tr('篇论文')),
  },
  fetch_url: {
    label: tr('打开网页'),
    say: (c) => {
      const title = str(c.output, 'title');
      return title
        ? tr('读了网页「{value}」', { value: clip(title, 40) })
        : tr('打开了网页 {value}', { value: hostOf(str(c.args, 'url')) ?? '' }).trim();
    },
    outcome: (c) =>
      c.output?.truncated === true ? tr('内容较长，只读了一部分') : (str(c.output, 'note') ?? null),
  },
  // ---- 文献库
  library_search: {
    label: tr('检索文献库'),
    say: (c) => {
      const q = str(c.args, 'query');
      return tail(tr('在文献库里搜索：'), q && clip(q, 40), tr('在文献库里搜索'));
    },
    outcome: (c) => count(c, 'results', tr('段相关内容')),
  },
  library_read: {
    label: tr('精读文献'),
    say: (c) => {
      const title = str(c.output, 'title') ?? str(c.args, 'paper');
      const sec = str(c.args, 'section');
      return tr('精读了文献{value}{value2}', {
        value: title ? tr('「{value}」', { value: clip(title, 40) }) : '',
        value2: sec ? tr('的「{sec}」', { sec }) : '',
      });
    },
  },
  library_import: {
    label: tr('导入文献'),
    change: true,
    say: (c) => {
      const title = str(c.output, 'title');
      if (title) return tr('把「{value}」导入了文献库', { value: clip(title, 40) });
      const id = str(c.args, 'arxiv')
        ? `arXiv ${str(c.args, 'arxiv')}`
        : str(c.args, 'doi')
          ? `DOI ${str(c.args, 'doi')}`
          : tr('一篇论文');
      return tr('把{id}导入了文献库', { id });
    },
    outcome: (c) => {
      if (c.output?.duplicate === true) return tr('文献库里已经有了');
      const s = str(c.output, 'status');
      if (s === 'ready') return tr('已解析，可以精读');
      if (s === 'needs_pdf') return tr('找不到开放 PDF，需要有人上传');
      if (s === 'failed') return tr('解析失败');
      return s ? tr('还在解析') : null;
    },
  },
  library_cite: {
    label: tr('取引用条目'),
    say: (c) => tr('取了 {value} 篇文献的引用条目', { value: arr(c.args, 'papers')?.length ?? 0 }),
  },
  // ---- Notebook
  list_notebooks: {
    label: tr('查看 Notebook 列表'),
    say: () => tr('查看了 Notebook 列表'),
    outcome: (c) => count(c, 'notebooks', tr('个 Notebook')),
  },
  read_notebook: {
    label: tr('读 Notebook'),
    say: (c) => tr('读了 Notebook{value}', { value: quoteName(str(c.output, 'title'), '') }),
    outcome: (c) => count(c, 'cells', tr('个单元格')),
  },
  edit_notebook: {
    label: tr('修改 Notebook'),
    change: true,
    say: (c) => {
      const ops = (arr(c.args, 'ops') ?? []).map((o) => str(asRec(o), 'op'));
      const n = (op: string) => ops.filter((x) => x === op).length;
      const parts = [
        n('insert') && tr('新增了 {value} 个单元格', { value: n('insert') }),
        n('replace') && tr('改了 {value} 个', { value: n('replace') }),
        n('delete') && tr('删了 {value} 个', { value: n('delete') }),
      ].filter(Boolean);
      const created = c.output?.created === true ? tr('新建了一个 Notebook，') : '';
      return tr('{created}在 Notebook 里{value}', {
        created,
        value: parts.length ? parts.join(tr('、')) : tr('改了单元格'),
      });
    },
    diff: (c) => {
      const n = arr(c.args, 'ops')?.length ?? 0;
      return n ? tr('{n} 处', { n }) : null;
    },
  },
  run_notebook_cells: {
    label: tr('运行 Notebook'),
    say: (c) => {
      const n = arr(c.output, 'cells')?.length ?? arr(c.args, 'cell_ids')?.length ?? 0;
      return n
        ? tr('在 Notebook 里运行了 {n} 个单元格', { n })
        : tr('在 Notebook 里运行了全部单元格');
    },
    outcome: (c) => {
      if (!c.output) return null;
      if (c.output.finished === false) return tr('超时了，还在后台跑');
      const cells = (arr(c.output, 'cells') ?? []).map(asRec);
      const failed = cells.filter((x) => x?.failed === true).length;
      return failed ? tr('{failed} 个单元格出错', { failed }) : tr('全部跑通');
    },
  },
  // ---- 云电脑
  computer_start: {
    label: tr('启动云电脑'),
    group: COMPUTER,
    say: () => tr('启动了云电脑'),
  },
  computer_screenshot: {
    label: tr('查看云电脑屏幕'),
    group: COMPUTER,
    say: () => tr('看了一眼云电脑屏幕'),
  },
  computer_click: { label: tr('云电脑点击'), group: COMPUTER, say: () => tr('在云电脑上点了一下') },
  computer_type: {
    label: tr('云电脑输入'),
    group: COMPUTER,
    say: () => tr('在云电脑上输入了文字'),
  },
  computer_key: {
    label: tr('云电脑按键'),
    group: COMPUTER,
    say: (c) => tr('在云电脑上按了 {value}', { value: str(c.args, 'keys') ?? tr('按键') }),
  },
  computer_scroll: {
    label: tr('云电脑滚动'),
    group: COMPUTER,
    say: (c) =>
      tr('在云电脑上向{value}滚动', {
        value: SCROLL_DIR[str(c.args, 'direction') ?? ''] ?? tr('下'),
      }),
  },
  computer_open_url: {
    label: tr('云电脑打开网页'),
    group: COMPUTER,
    say: (c) => tr('在云电脑上打开了 {value}', { value: hostOf(str(c.args, 'url')) ?? tr('网页') }),
  },
  computer_exec: {
    label: tr('云电脑运行命令'),
    group: COMPUTER,
    say: (c) => {
      const cmd = str(c.args, 'command');
      return tail(tr('在云电脑上运行命令：'), cmd && clip(cmd, 50), tr('在云电脑上运行了命令'));
    },
    outcome: (c) => {
      if (c.output?.timed_out === true) return tr('超时被终止');
      const code = num(c.output, 'exit_code');
      if (code === null) return null;
      return code === 0 ? tr('运行成功') : tr('运行失败（退出码 {code}）', { code });
    },
  },
  // ---- Skill 与目标
  load_skill: {
    label: tr('加载技能'),
    say: (c) => tr('加载了技能{value}', { value: quoteName(str(c.args, 'name'), '') }),
  },
  read_skill_file: {
    label: tr('读技能文件'),
    say: (c) => tr('读了技能{value}里的说明', { value: quoteName(str(c.args, 'name'), '') }),
  },
  update_goal: {
    label: tr('更新目标'),
    say: (c) => {
      const s = str(c.args, 'summary');
      return str(c.args, 'status') === 'blocked'
        ? tr('报告目标受阻{value}', { value: s ? tr('：{value}', { value: clip(s, 50) }) : '' })
        : tr('标记目标已完成{value}', { value: s ? tr('：{value}', { value: clip(s, 50) }) : '' });
    },
  },
};

/** 服务端注册的全部工具名（测试用：保证每个都有中文说法） */
export const KNOWN_TOOLS = Object.keys(TOOLS);

const MCP_RE = /^mcp__(.+?)__(.+)$/u;

/** 工具的中文动作名；不认识的工具返回 null。 */
export function toolActionLabel(name: string | null | undefined): string | null {
  if (!name) return null;
  if (TOOLS[name]) return TOOLS[name].label;
  if (MCP_RE.test(name)) return tr('调用外部工具');
  return null;
}

/** 写入类工具（不认识的按名字猜） */
const CHANGE_GUESS = /write|edit|update|create|patch|commit|log_|draft_/iu;
export function isChangeTool(name: string | null | undefined): boolean {
  if (!name) return false;
  const spec = TOOLS[name];
  if (spec) return spec.change === true;
  if (MCP_RE.test(name)) return false;
  return CHANGE_GUESS.test(name);
}

/** 合并分组的 key：云电脑、认领、记忆各合成一组，其余同名工具连续出现才合并 */
export function toolGroupKey(name: string): string {
  return TOOLS[name]?.group ?? name;
}

// ---------------------------------------------------------------- 组装

export function toolCallOf(call: AgentStep | null, result: AgentStep | null): ToolCall {
  const name = call?.name ?? result?.name ?? '';
  const dataArgs = asRec(call?.data.args);
  const args = dataArgs ?? asRec(parseJson(call?.content));
  const output = asRec(parseJson(result?.content));
  const okFlag = result?.data.ok;
  const ok =
    result === null
      ? null
      : okFlag === false
        ? false
        : okFlag === true
          ? true
          : !(output && typeof output.error === 'string');
  return { name, call, result, args, output, ok };
}

export function summarizeCall(c: ToolCall, ctx: SummaryContext = {}): CallSummary {
  const spec = TOOLS[c.name];
  let text: string;
  if (spec) {
    text = spec.say(c, ctx);
  } else {
    const mcp = MCP_RE.exec(c.name);
    text = mcp
      ? tr('调用了外部工具「{value}」（{value2}）', { value: mcp[2], value2: mcp[1] })
      : tr('执行了一步操作');
  }
  const diff = c.ok === false ? null : (spec?.diff?.(c) ?? null);
  if (c.ok === false) {
    return { text, outcome: tr('没成功：{value}', { value: errorReason(c) }), tone: 'error', diff };
  }
  const outcome = c.ok === null ? null : (spec?.outcome?.(c, ctx) ?? null);
  return { text, outcome, tone: c.ok ? 'success' : 'neutral', diff };
}

export interface ToolGroupSummary {
  text: string;
  outcome: string | null;
  tone: Tone;
}

/** 一组连续的同类调用 → 一句话（只有一次时就是那一次的说法） */
export function summarizeGroup(calls: ToolCall[], ctx: SummaryContext = {}): ToolGroupSummary {
  const parts = calls.map((c) => summarizeCall(c, ctx));
  if (calls.length === 1) {
    const p = parts[0]!;
    return { text: p.text, outcome: p.outcome, tone: p.tone };
  }
  const n = calls.length;
  const failed = parts.filter((p) => p.tone === 'error').length;
  const pending = calls.filter((c) => c.ok === null).length;
  const outcome = failed
    ? failed === n
      ? tr('{n} 次都没成功', { n })
      : tr('其中 {failed} 次没成功', { failed })
    : null;
  const tone: Tone = failed ? 'error' : pending ? 'neutral' : 'success';
  const first = calls[0]!.name;
  const key = toolGroupKey(first);

  let text: string;
  if (parts.every((p) => p.text === parts[0]!.text)) {
    text = tr('{text}（{n} 次）', { text: parts[0]!.text, n });
  } else if (key === COMPUTER) {
    text = tr('在云电脑上操作了 {n} 步', { n });
  } else if (first === 'read_document') {
    const names = [...new Set(calls.map((c) => docName(c, ctx)))];
    text =
      names.length === 1
        ? tr('分 {n} 次读了文档{value}', { n, value: names[0] })
        : tr('读了 {count} 份文档：{value}{value2}', {
            count: names.length,
            value: names.slice(0, 3).join(''),
            value2: names.length > 3 ? tr('等') : '',
          });
  } else if (first === 'edit_document') {
    const names = [...new Set(calls.map((c) => docName(c, ctx)))];
    text =
      names.length === 1
        ? tr('改了{value} {n} 处', { value: names[0], n })
        : tr('改了 {count} 份文档：{value}', {
            count: names.length,
            value: names.slice(0, 3).join(''),
          });
  } else if (key === 'claims') {
    text = tr('处理了 {n} 项认领', { n });
  } else if (key === 'memory') {
    text = tr('查阅了 {n} 次项目记忆', { n });
  } else {
    text = tr('{value} {n} 次', {
      value: TOOLS[first]?.label ?? (MCP_RE.test(first) ? tr('调用外部工具') : tr('执行操作')),
      n,
    });
  }
  return { text, outcome, tone };
}

// ---------------------------------------------------------------- 时间线

export type ActivityItem =
  | { kind: 'text'; id: string; step: AgentStep }
  | { kind: 'thinking'; id: string; steps: AgentStep[] }
  | { kind: 'tools'; id: string; group: string; calls: ToolCall[] }
  | { kind: 'note'; id: string; step: AgentStep };

function callIdOf(s: AgentStep): string | null {
  const v = s.data.callId;
  return typeof v === 'string' && v ? v : null;
}

/**
 * 一轮里的步骤 → 给人看的条目：工具调用和结果配成一对（优先按 callId，其次同名的下一个结果），
 * 连续的同类调用合成一组，连续的思考合成一块。
 */
export function buildActivity(steps: AgentStep[]): ActivityItem[] {
  const resultById = new Map<string, AgentStep>();
  for (const s of steps) {
    const id = s.kind === 'tool_result' ? callIdOf(s) : null;
    if (id) resultById.set(id, s);
  }
  const used = new Set<string>();
  const items: ActivityItem[] = [];

  steps.forEach((s, i) => {
    const last = items[items.length - 1];
    switch (s.kind) {
      case 'text':
        items.push({ kind: 'text', id: s.id, step: s });
        return;
      case 'thinking':
        if (last?.kind === 'thinking') last.steps.push(s);
        else items.push({ kind: 'thinking', id: s.id, steps: [s] });
        return;
      case 'note':
        items.push({ kind: 'note', id: s.id, step: s });
        return;
      case 'tool_call': {
        const cid = callIdOf(s);
        let result = cid ? (resultById.get(cid) ?? null) : null;
        if (!result) {
          result =
            steps
              .slice(i + 1)
              .find(
                (r) =>
                  r.kind === 'tool_result' &&
                  r.name === s.name &&
                  !used.has(r.id) &&
                  (!cid || !callIdOf(r)),
              ) ?? null;
        }
        if (result) used.add(result.id);
        pushCall(items, toolCallOf(s, result));
        return;
      }
      case 'tool_result':
        // 调用在更早一页里（还没加载）：单独算一次
        if (used.has(s.id)) return;
        if (callIdOf(s) && steps.some((c) => c.kind === 'tool_call' && callIdOf(c) === callIdOf(s)))
          return;
        used.add(s.id);
        pushCall(items, toolCallOf(null, s));
        return;
    }
  });
  return items;
}

function pushCall(items: ActivityItem[], call: ToolCall) {
  const group = toolGroupKey(call.name);
  const last = items[items.length - 1];
  if (last?.kind === 'tools' && last.group === group) {
    last.calls.push(call);
    return;
  }
  items.push({
    kind: 'tools',
    id: call.call?.id ?? call.result?.id ?? `${group}-${items.length}`,
    group,
    calls: [call],
  });
}

/** 原始数据：参数和结果，格式化成可读的 JSON 文本（只在「原始数据」折叠块里显示） */
export function rawText(step: AgentStep | null): string {
  if (!step) return '';
  const parsed =
    step.kind === 'tool_call' && step.data.args !== undefined
      ? step.data.args
      : parseJson(step.content);
  return parsed === null ? step.content : JSON.stringify(parsed, null, 2);
}
