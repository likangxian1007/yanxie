import {
  assigneeThreadId,
  COORDINATOR_ASSIGNEE,
  type ActorRef,
  type AgentSession,
  type ClaimResourceKind,
  type WorkClaim,
} from '@srh/shared';
import type { AvatarKind } from '@/components/ui';
import { tr, trServer } from '@/lib/i18n';

/**
 * 右侧动态面板的可读名字：把认领里的 doc_… / exp_… 原始 id 换成标题，
 * 把一律叫“研协”的 agent 换成“谁的 agent”。全部是纯函数，数据由 use-panel-lookup 提供。
 */

export interface PanelLookup {
  pid: string;
  /** undefined = 还没加载到 / 找不到 */
  docTitle: (id: string) => string | undefined;
  experimentTitle: (id: string) => string | undefined;
  threadTitle: (id: string) => string | undefined;
  memberName: (userId: string) => string | undefined;
  memberColor: (userId: string) => number | undefined;
  agent: (sessionId: string) => AgentSession | undefined;
}

export interface ResourceLabel {
  label: string;
  href: string | null;
}

/** id 规则：`<前缀>_<26 位 Crockford base32>`（packages/shared/src/ids.ts） */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const DOC_REF_RE = new RegExp(`^(doc_${ULID})(?:#(.*))?$`, 'su');
const ID_RE = (prefix: string) => new RegExp(`^${prefix}_${ULID}$`, 'u');
const EXP_RE = ID_RE('exp');
const RESEARCH_RE = ID_RE('rrc');
const CARD_RE = ID_RE('crd');
const THREAD_RE = ID_RE('thr');
const ANY_ID_RE = (prefix: string) => new RegExp(`${prefix}_${ULID}`, 'gu');

/** 有些地方写成 `doc:doc_…`，去掉类型前缀 */
function stripTypePrefix(ref: string): string {
  return ref.replace(new RegExp(`^[a-z_]+:(?=[a-z]+_${ULID})`, 'u'), '');
}

function named(title: string | undefined, fallback: string): string | undefined {
  if (title === undefined) return undefined;
  return title.trim() || fallback;
}

/** 认领对象 → 「《对比学习研究计划》· 背景」+ 跳转地址 */
export function resolveResource(
  kind: ClaimResourceKind,
  rawRef: string,
  lk: PanelLookup,
): ResourceLabel {
  const ref = stripTypePrefix(rawRef.trim());
  const base = `/p/${lk.pid}`;
  switch (kind) {
    case 'document':
    case 'doc_section': {
      const m = DOC_REF_RE.exec(ref);
      if (!m) return { label: tr('文档 {ref}', { ref }), href: null };
      const id = m[1] ?? '';
      const title = named(lk.docTitle(id), tr('未命名文档'));
      const name = title === undefined ? tr('文档') : tr('《{title}》', { title });
      const section = m[2]?.trim();
      // 》自带留白，后面不再加空格：《标题》· 背景 / 文档 · 背景
      const label = section ? `${name}${title === undefined ? ' ' : ''}· ${section}` : name;
      // 文档页暂不支持 #小节 定位，只跳到文档
      return { label, href: `${base}/docs/${id}` };
    }
    case 'experiment': {
      if (!EXP_RE.test(ref)) return { label: tr('实验 {ref}', { ref }), href: null };
      const title = named(lk.experimentTitle(ref), tr('未命名实验'));
      return {
        label: title === undefined ? tr('实验') : tr('实验「{title}」', { title }),
        href: `${base}/experiments/${ref}`,
      };
    }
    case 'research':
      return RESEARCH_RE.test(ref)
        ? { label: tr('研究空间 {ref}', { ref }), href: `${base}/research/${ref}` }
        : { label: tr('研究空间 {ref}', { ref }), href: null };
    case 'card':
      return CARD_RE.test(ref)
        ? { label: tr('看板卡片'), href: `${base}/board` }
        : { label: tr('看板卡片 {ref}', { ref }), href: null };
    case 'file':
      return { label: tr('文件 {ref}', { ref }), href: null };
    case 'topic': {
      if (THREAD_RE.test(ref)) {
        const title = named(lk.threadTitle(ref), tr('未命名线程'));
        return {
          label: title === undefined ? tr('线程') : tr('线程「{title}」', { title }),
          href: `${base}/threads/${ref}`,
        };
      }
      return { label: tr('议题「{ref}」', { ref }), href: null };
    }
  }
}

/** 没有认领对象可对照时，按 id 前缀猜资源类型 */
export function guessResourceKind(rawRef: string): ClaimResourceKind {
  const ref = stripTypePrefix(rawRef.trim());
  if (DOC_REF_RE.test(ref)) return ref.includes('#') ? 'doc_section' : 'document';
  if (EXP_RE.test(ref)) return 'experiment';
  if (CARD_RE.test(ref)) return 'card';
  if (THREAD_RE.test(ref) || !/[/.*]/u.test(ref)) return 'topic';
  return 'file';
}

export function claimLabel(c: WorkClaim, lk: PanelLookup): ResourceLabel {
  return resolveResource(c.resourceKind, c.resourceRef, lk);
}

// ---------------------------------------------------------------- 操作者

export interface ActorLabel {
  name: string;
  kind: AvatarKind;
  color: number | undefined;
}

function threadAgentName(threadId: string, lk: PanelLookup): string {
  const title = lk.threadTitle(threadId)?.trim();
  return title ? tr('{title} 的 agent', { title }) : tr('线程 agent');
}

/**
 * 操作者的显示名：成员用成员名；agent 统一叫“研协”，这里换成
 * 协调者 / <线程标题> 的 agent / <成员> 的个人 agent。
 * actor.id 可能是 agent 会话 id，也可能是 `agent:coordinator` / `agent:<threadId>`。
 */
export function actorLabel(
  actor: ActorRef,
  lk: PanelLookup,
  /** 事件或认领所在的线程，找不到 agent 会话时用来兜底 */
  fallbackThreadId?: string | null,
): ActorLabel {
  const id = actor.id ?? '';
  if (actor.kind === 'user') {
    return {
      name: (id && lk.memberName(id)) || trServer(actor.name),
      kind: 'user',
      color: id ? lk.memberColor(id) : undefined,
    };
  }
  if (actor.kind !== 'agent') return { name: trServer(actor.name), kind: 'user', color: undefined };

  const agent = (name: string): ActorLabel => ({ name, kind: 'agent', color: undefined });
  if (id === COORDINATOR_ASSIGNEE)
    return { name: tr('协调者'), kind: 'coordinator', color: undefined };
  const assigneeThread = assigneeThreadId(id);
  if (assigneeThread) return agent(threadAgentName(assigneeThread, lk));

  const session = id ? lk.agent(id) : undefined;
  if (session?.role === 'coordinator') {
    return { name: tr('协调者'), kind: 'coordinator', color: undefined };
  }
  if (session?.role === 'personal') {
    const owner = session.workingForUserId ? lk.memberName(session.workingForUserId) : undefined;
    return agent(owner ? tr('{owner} 的个人 agent', { owner }) : tr('个人 agent'));
  }
  if (session?.threadId) return agent(threadAgentName(session.threadId, lk));
  if (fallbackThreadId) return agent(threadAgentName(fallbackThreadId, lk));
  return agent(trServer(actor.name));
}

// ---------------------------------------------------------------- 最近活动

const CLAIM_CREATED_PREFIX = tr('认领了 ');
/** 资源与意图之间的分隔（中文全角冒号，英文 ": "），与 apply-event.ts 生成的文案一致 */
const CLAIM_SEP = tr('：{intent}', { intent: '' });
const CLAIM_CONFLICT_PREFIX = tr('与他人的认领重叠：');

/**
 * 认领类活动的文案里带着原始 resourceRef（lib/apply-event.ts 生成），这里换成可读名字。
 * 能在当前认领里找到同一个 resourceRef 时用它的类型，否则按前缀猜。
 */
export function describeActivityText(
  entry: { type: string; text: string; href: string | null },
  claims: readonly WorkClaim[],
  lk: PanelLookup,
): ResourceLabel {
  const fallback = { label: entry.text, href: entry.href };
  const kindOf = (ref: string) =>
    claims.find((c) => c.resourceRef === ref)?.resourceKind ?? guessResourceKind(ref);

  if (entry.type === 'claim.created' && entry.text.startsWith(CLAIM_CREATED_PREFIX)) {
    const rest = entry.text.slice(CLAIM_CREATED_PREFIX.length);
    // 先找完整匹配的认领，避免小节标题里本身带“：”时切错
    const known = claims.find(
      (c) => rest === c.resourceRef || rest.startsWith(`${c.resourceRef}${CLAIM_SEP}`),
    );
    const cut = known ? known.resourceRef.length : rest.indexOf(CLAIM_SEP);
    const ref = cut < 0 ? rest : rest.slice(0, cut);
    const intent = cut < 0 ? '' : rest.slice(cut + CLAIM_SEP.length);
    const target = resolveResource(known?.resourceKind ?? kindOf(ref), ref, lk);
    return {
      label: `${CLAIM_CREATED_PREFIX}${target.label}${intent ? tr('：{intent}', { intent }) : ''}`,
      href: entry.href ?? target.href,
    };
  }
  if (entry.type === 'claim.conflict' && entry.text.startsWith(CLAIM_CONFLICT_PREFIX)) {
    const ref = entry.text.slice(CLAIM_CONFLICT_PREFIX.length);
    const target = resolveResource(kindOf(ref), ref, lk);
    return { label: `${CLAIM_CONFLICT_PREFIX}${target.label}`, href: entry.href ?? target.href };
  }
  return fallback;
}

/** 从一组文本里收集要查标题的文档 / 实验 id */
export function collectRefIds(texts: Iterable<string>): { docIds: string[]; expIds: string[] } {
  const docs = new Set<string>();
  const exps = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(ANY_ID_RE('doc'))) docs.add(m[0]);
    for (const m of t.matchAll(ANY_ID_RE('exp'))) exps.add(m[0]);
  }
  return { docIds: [...docs].sort(), expIds: [...exps].sort() };
}
