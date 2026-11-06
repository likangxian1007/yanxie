import { z } from 'zod';
import { ActorRef } from './entities';
import { DocumentKind } from './entities-collab';
import { tr } from './i18n';

/**
 * 版本管理（API.md §2.17）：文档、notebook、项目文件的历史版本，agent 的改动提案，
 * 以及项目的版本设置（agent 是否直接写入、关联的 GitHub 仓库）。
 * 归属：版本管理线程（modules/versioning、features/versioning）。
 * 这里还放前后端共用的纯函数 diff：服务端用它切提案的改动块，前端用它画版本对比。
 */
const Iso = z.string().describe(tr('ISO 8601 时间'));
const Id = z.string();

// ---------------------------------------------------------------- 历史版本

/** 有版本历史的对象：协同文档（四类）、notebook、项目文件 */
export const VersionTargetKind = z.enum(['document', 'notebook', 'file']);
export type VersionTargetKind = z.infer<typeof VersionTargetKind>;

/**
 * 版本是怎么来的：manual 手动「存为版本」；auto 编辑时的自动快照（按对象节流）；
 * pre_restore / restore 回滚前的备份与回滚结果；pre_merge / merge 合入改动提案前后。
 */
export const VersionKind = z.enum([
  'manual',
  'auto',
  'pre_restore',
  'restore',
  'pre_merge',
  'merge',
]);
export type VersionKind = z.infer<typeof VersionKind>;

export const VERSION_KIND_LABEL: Record<VersionKind, string> = {
  manual: tr('手动保存'),
  auto: tr('自动快照'),
  pre_restore: tr('回滚前备份'),
  restore: tr('回滚'),
  pre_merge: tr('合入前备份'),
  merge: tr('合入提案'),
};

export const Version = z.object({
  id: Id,
  projectId: Id,
  targetKind: VersionTargetKind,
  targetId: Id,
  kind: VersionKind,
  /** 版本说明（手动保存时填写；系统版本自动生成） */
  note: z.string(),
  /** 内容大小（字节，可读表示的 UTF-8 长度；文件为原始字节数） */
  size: z.number().int(),
  createdBy: ActorRef,
  createdAt: Iso,
});
export type Version = z.infer<typeof Version>;

export const SheetSnapshot = z.object({
  name: z.string(),
  /** A1 → 原始输入（`=` 开头为公式），只含非空单元格 */
  cells: z.record(z.string(), z.string()),
});
export type SheetSnapshot = z.infer<typeof SheetSnapshot>;

export const NotebookCellSnapshot = z.object({
  id: z.string(),
  type: z.string(),
  source: z.string(),
});
export type NotebookCellSnapshot = z.infer<typeof NotebookCellSnapshot>;

/**
 * 版本内容的可读表示（对比与预览用）：
 * - text：富文本 / 幻灯片为 markdown（按段落对比），LaTeX 与文本文件为源码（按行对比）
 * - notebook：单元格列表（按单元格 id 对比）
 * - sheet：每张工作表的非空单元格（逐单元格对比）
 * - binary：二进制文件只给大小与类型
 */
export const VersionContent = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('text'),
    unit: z.enum(['block', 'line']),
    language: z.enum(['markdown', 'latex', 'plain']),
    text: z.string(),
  }),
  z.object({ format: z.literal('notebook'), cells: z.array(NotebookCellSnapshot) }),
  z.object({ format: z.literal('sheet'), sheets: z.array(SheetSnapshot) }),
  z.object({ format: z.literal('binary'), size: z.number().int(), mime: z.string() }),
]);
export type VersionContent = z.infer<typeof VersionContent>;

export const VersionDetail = z.object({ version: Version, content: VersionContent });
export type VersionDetail = z.infer<typeof VersionDetail>;

export const VersionTargetQuery = z.object({
  targetKind: VersionTargetKind,
  targetId: z.string().min(1),
});
export type VersionTargetQuery = z.input<typeof VersionTargetQuery>;

export const VersionCreateInput = z.object({
  targetKind: VersionTargetKind,
  targetId: z.string().min(1),
  note: z.string().trim().max(200).default(''),
});
export type VersionCreateInput = z.input<typeof VersionCreateInput>;

/** POST P/versions/:id/restore 的结果：回滚前的备份版本与回滚后新存的版本 */
export const VersionRestoreResult = z.object({ backup: Version, restored: Version });
export type VersionRestoreResult = z.infer<typeof VersionRestoreResult>;

// ---------------------------------------------------------------- 改动提案

export const ProposalTargetKind = z.enum(['document', 'notebook']);
export type ProposalTargetKind = z.infer<typeof ProposalTargetKind>;

export const ProposalStatus = z.enum(['open', 'merged', 'closed']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const HunkDecision = z.enum(['pending', 'accepted', 'rejected']);
export type HunkDecision = z.infer<typeof HunkDecision>;

/**
 * 一处改动（像 PR 里的一个 hunk），三种：
 * - text：文本的一段（富文本按段落，LaTeX 按行）：old → new，before / after 是相邻未改动的段落（定位与展示用）
 * - cell：表格的一个单元格
 * - nb_cell：notebook 的一个单元格：新增（插在 afterCellId 后面，null = 最前）、删除或修改
 */
export const ProposalHunk = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    id: z.string(),
    decision: HunkDecision,
    before: z.array(z.string()),
    old: z.array(z.string()),
    new: z.array(z.string()),
    after: z.array(z.string()),
    /** 提出时在正文里的位置（段落 / 行下标）与在草稿里的位置 */
    at: z.number().int(),
    atNew: z.number().int(),
  }),
  z.object({
    kind: z.literal('cell'),
    id: z.string(),
    decision: HunkDecision,
    sheet: z.string(),
    ref: z.string(),
    old: z.string(),
    new: z.string(),
  }),
  z.object({
    kind: z.literal('nb_cell'),
    id: z.string(),
    decision: HunkDecision,
    op: z.enum(['add', 'remove', 'modify']),
    cellId: z.string(),
    cellType: z.string(),
    old: z.string(),
    new: z.string(),
    afterCellId: z.string().nullable(),
  }),
]);
export type ProposalHunk = z.infer<typeof ProposalHunk>;

export const ProposalMergeResult = z.object({
  applied: z.array(z.string()),
  rejected: z.array(z.string()),
  /** 正文在提案之后被人改过、无法自动合入而跳过的改动 */
  conflicted: z.array(z.string()),
});
export type ProposalMergeResult = z.infer<typeof ProposalMergeResult>;

export const ChangeProposal = z.object({
  id: Id,
  projectId: Id,
  targetKind: ProposalTargetKind,
  targetId: Id,
  targetTitle: z.string(),
  /** 文档类型（targetKind=document 时） */
  docKind: DocumentKind.nullable(),
  /** notebook 所属实验（targetKind=notebook 时；页面入口在实验详情里） */
  targetExperimentId: Id.nullable(),
  title: z.string(),
  /** agent 写的改动说明 */
  explanation: z.string(),
  author: ActorRef,
  threadId: Id.nullable(),
  reviewId: Id.nullable(),
  status: ProposalStatus,
  /** 文本提案的切分单位：block = 段落，line = 行 */
  unit: z.enum(['block', 'line']).nullable(),
  hunks: z.array(ProposalHunk),
  /** 开放中的提案：按正文当前内容算出的冲突改动 id（正文在这几处已被人改过） */
  conflicts: z.array(z.string()),
  mergeResult: ProposalMergeResult.nullable(),
  mergedBy: ActorRef.nullable(),
  mergedAt: Iso.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type ChangeProposal = z.infer<typeof ChangeProposal>;

export const ProposalListQuery = z.object({
  targetKind: ProposalTargetKind.optional(),
  targetId: z.string().min(1).optional(),
  status: ProposalStatus.optional(),
});
export type ProposalListQuery = z.input<typeof ProposalListQuery>;

/** 逐条接受 / 拒绝（只改传了的） */
export const ProposalDecisionsInput = z.object({
  decisions: z.record(z.string(), HunkDecision),
});
export type ProposalDecisionsInput = z.input<typeof ProposalDecisionsInput>;

export const ProposalMergeInput = z.object({
  /** true = 还没决定的改动一并接受（「LGTM 并全部合入」）；false = 只合入已接受的 */
  acceptPending: z.boolean().default(false),
  /** 有冲突时跳过冲突的改动、合入其余；false 时有冲突返回 409 */
  skipConflicts: z.boolean().default(false),
  /** 同时给审阅一个 LGTM（当前用户是审阅人时） */
  lgtm: z.boolean().default(false),
});
export type ProposalMergeInput = z.input<typeof ProposalMergeInput>;

// ---------------------------------------------------------------- 项目设置

export const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;

export const VersioningSettings = z.object({
  projectId: Id,
  /** true = agent 改文档 / notebook 直接写进正文（草稿阶段）；false = 生成改动提案 */
  agentDirectWrite: z.boolean(),
  githubRepo: z.string().nullable(),
  githubBranch: z.string(),
  /** 访问令牌只写不读，这里只说有没有 */
  githubTokenSet: z.boolean(),
  updatedBy: ActorRef.nullable(),
  updatedAt: Iso.nullable(),
});
export type VersioningSettings = z.infer<typeof VersioningSettings>;

export const VersioningSettingsInput = z.object({
  agentDirectWrite: z.boolean().optional(),
  githubRepo: z
    .string()
    .trim()
    .regex(GITHUB_REPO_RE, tr('仓库写成 owner/name，例如 lab/paper-code'))
    .nullable()
    .optional(),
  githubBranch: z.string().trim().min(1).max(100).optional(),
  /** 传 null 清除 */
  githubToken: z.string().trim().min(10).max(500).nullable().optional(),
});
export type VersioningSettingsInput = z.input<typeof VersioningSettingsInput>;

// ---------------------------------------------------------------- 事件

export const VERSIONING_EVENT_PAYLOADS = {
  'version.created': Version,
  'proposal.created': ChangeProposal,
  'proposal.updated': ChangeProposal,
  'versioning.settings_updated': VersioningSettings,
} as const;

// ---------------------------------------------------------------- 纯函数：diff

export type DiffOpKind = 'same' | 'add' | 'del';
export interface DiffOp {
  kind: DiffOpKind;
  text: string;
}

/** LCS 表格子上限（超过就退化为整段删除 + 整段新增） */
const MAX_CELLS = 4_000_000;

/** 序列 diff：先剥公共前后缀，中间做 LCS。 */
export function diffSeq(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out: DiffOp[] = [];
  for (let i = 0; i < start; i += 1) out.push({ kind: 'same', text: a[i]! });
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_CELLS) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        t[i * w + j] =
          a[start + i] === b[start + j]
            ? t[(i + 1) * w + j + 1]! + 1
            : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ kind: 'same', text: a[start + i]! });
        i += 1;
        j += 1;
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) {
        out.push({ kind: 'del', text: a[start + i]! });
        i += 1;
      } else {
        out.push({ kind: 'add', text: b[start + j]! });
        j += 1;
      }
    }
    for (; i < n; i += 1) out.push({ kind: 'del', text: a[start + i]! });
    for (; j < m; j += 1) out.push({ kind: 'add', text: b[start + j]! });
  } else {
    for (let i = start; i < endA; i += 1) out.push({ kind: 'del', text: a[i]! });
    for (let j = start; j < endB; j += 1) out.push({ kind: 'add', text: b[j]! });
  }
  for (let i = endA; i < a.length; i += 1) out.push({ kind: 'same', text: a[i]! });
  return out;
}

/** 把文本切成对比单位：block = 空行分隔的段落，line = 行 */
export function splitSegments(text: string, unit: 'block' | 'line'): string[] {
  const t = text.replace(/\r\n?/gu, '\n');
  if (unit === 'line') {
    if (t === '') return [];
    const lines = t.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  return t
    .split(/\n[ \t]*\n+/u)
    .map((s) => s.replace(/^\n+|\s+$/gu, ''))
    .filter((s) => s.length > 0);
}

export function segmentJoiner(unit: 'block' | 'line'): string {
  return unit === 'block' ? '\n\n' : '\n';
}

/** FNV-1a 32 位，转 base36：改动块的稳定 id（内容不变 id 就不变，已做的决定能保留） */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface TextHunkDraft {
  before: string[];
  old: string[];
  new: string[];
  after: string[];
  /** old 在旧序列里的起始下标 */
  at: number;
  /** new 在新序列里的起始下标 */
  atNew: number;
}

/** 序列改动块：相邻的增删合成一块，带前后各 1 段上下文 */
export function seqHunks(a: readonly string[], b: readonly string[]): TextHunkDraft[] {
  const ops = diffSeq(a, b);
  const hunks: TextHunkDraft[] = [];
  let ia = 0;
  let ib = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === 'same') {
      i += 1;
      ia += 1;
      ib += 1;
      continue;
    }
    const h: TextHunkDraft = {
      before: i > 0 ? [ops[i - 1]!.text] : [],
      old: [],
      new: [],
      after: [],
      at: ia,
      atNew: ib,
    };
    while (i < ops.length && ops[i]!.kind !== 'same') {
      if (ops[i]!.kind === 'del') {
        h.old.push(ops[i]!.text);
        ia += 1;
      } else {
        h.new.push(ops[i]!.text);
        ib += 1;
      }
      i += 1;
    }
    if (i < ops.length) h.after.push(ops[i]!.text);
    hunks.push(h);
  }
  return hunks;
}

/** 文本改动块（先按 unit 切分） */
export function textHunks(
  oldText: string,
  newText: string,
  unit: 'block' | 'line',
): TextHunkDraft[] {
  return seqHunks(splitSegments(oldText, unit), splitSegments(newText, unit));
}

export function columnName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A1 → { row, col }（0 起）；不合法返回 null */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,5})$/u.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

/** 单元格比较顺序：先行后列 */
export function compareCellRefs(a: string, b: string): number {
  const pa = parseCellRef(a);
  const pb = parseCellRef(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  return pa.row - pb.row || pa.col - pb.col;
}

export interface SheetCellChange {
  sheet: string;
  ref: string;
  old: string;
  new: string;
}

/** 表格逐单元格对比：按工作表名配对，返回值不同的单元格（空串 = 空单元格） */
export function sheetCellChanges(a: SheetSnapshot[], b: SheetSnapshot[]): SheetCellChange[] {
  const names: string[] = [];
  for (const s of [...b, ...a]) if (!names.includes(s.name)) names.push(s.name);
  const out: SheetCellChange[] = [];
  for (const name of names) {
    const ca = a.find((s) => s.name === name)?.cells ?? {};
    const cb = b.find((s) => s.name === name)?.cells ?? {};
    const refs = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort(compareCellRefs);
    for (const ref of refs) {
      const o = ca[ref] ?? '';
      const n = cb[ref] ?? '';
      if (o !== n) out.push({ sheet: name, ref, old: o, new: n });
    }
  }
  return out;
}

export interface NotebookCellChange {
  status: 'same' | 'add' | 'remove' | 'modify';
  cellId: string;
  cellType: string;
  old: string;
  new: string;
  /** 新增的单元格插在哪个单元格之后（新版本里的前一个），null = 最前 */
  afterCellId: string | null;
}

/**
 * notebook 逐单元格对比：按单元格 id 配对。顺序按新版本，删除的单元格放在它原来的前一个单元格后面。
 * 类型变化也算修改。
 */
export function notebookCellChanges(
  a: NotebookCellSnapshot[],
  b: NotebookCellSnapshot[],
): NotebookCellChange[] {
  const oldById = new Map(a.map((c) => [c.id, c]));
  const newIds = new Set(b.map((c) => c.id));
  const out: NotebookCellChange[] = [];
  let prev: string | null = null;
  const flushRemoved = (afterOld: string | null) => {
    // a 中位于 afterOld 之后、且在 b 里已不存在的连续单元格
    let idx = afterOld === null ? 0 : a.findIndex((c) => c.id === afterOld) + 1;
    if (afterOld !== null && idx === 0) return;
    for (; idx < a.length; idx += 1) {
      const c = a[idx]!;
      if (newIds.has(c.id)) break;
      out.push({
        status: 'remove',
        cellId: c.id,
        cellType: c.type,
        old: c.source,
        new: '',
        afterCellId: null,
      });
    }
  };
  flushRemoved(null);
  for (const c of b) {
    const o = oldById.get(c.id);
    if (!o) {
      out.push({
        status: 'add',
        cellId: c.id,
        cellType: c.type,
        old: '',
        new: c.source,
        afterCellId: prev,
      });
    } else {
      const changed = o.source !== c.source || o.type !== c.type;
      out.push({
        status: changed ? 'modify' : 'same',
        cellId: c.id,
        cellType: c.type,
        old: o.source,
        new: c.source,
        afterCellId: prev,
      });
      flushRemoved(c.id);
    }
    prev = c.id;
  }
  return out;
}
