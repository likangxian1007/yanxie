import { discussionKey, useDiscussionReading } from '@/features/discussion/reading-store';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type {
  AgentSession,
  AgentStep,
  AnyProjectEvent,
  InboxItem,
  MemoryFile,
  Message,
  Page,
  Project,
  ProjectMember,
  Routine,
  Thread,
  WorkClaim,
} from '@srh/shared';
import { invalidateHarness } from './harness';
import { qk, type ThreadListFilter } from './query-keys';
import { useRealtimeStore, type ActivityEntry } from './realtime-store';
import { tr } from '@/lib/i18n';

/**
 * 把 /ws 项目事件写进 react-query 缓存（payload 是变更后的完整对象，直接替换）。
 * 协作域（文档、看板……）的事件这里不处理，由各 feature 通过 useProjectEvent 自己更新。
 */

export type MessagePages = InfiniteData<Page<Message>, string | null>;

function upsertById<T extends { id: string }>(list: T[] | undefined, item: T, prepend = false) {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function removeById<T extends { id: string }>(list: T[] | undefined, id: string) {
  return list?.filter((x) => x.id !== id);
}

/** 消息分页（新→旧）：新消息插到第一页最前；已存在则替换。也替换同 clientId 的乐观消息。 */
export function upsertMessage(
  data: MessagePages | undefined,
  msg: Message,
): MessagePages | undefined {
  if (!data) return data;
  let found = false;
  const pages = data.pages.map((page) => {
    const items = page.items.map((m) => {
      if (m.id === msg.id) {
        found = true;
        return msg;
      }
      return m;
    });
    return { ...page, items };
  });
  if (!found) {
    const first = pages[0] ?? { items: [], nextCursor: null };
    // 去掉同作者、同正文的乐观占位
    const items = first.items.filter(
      (m) =>
        !(
          m.id.startsWith('tmp_') &&
          m.body === msg.body &&
          m.author.id === msg.author.id &&
          m.agentVisible === msg.agentVisible
        ),
    );
    pages[0] = { ...first, items: [msg, ...items] };
  }
  return { ...data, pages };
}

export function removeMessage(data: MessagePages | undefined, id: string) {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((p) => ({ ...p, items: p.items.filter((m) => m.id !== id) })),
  };
}

/** Update only already loaded streams; an unopened channel must fetch its own complete page. */
export function updateMessageCaches(qc: QueryClient, msg: Message, temporaryId?: string) {
  const prefix = msg.threadId
    ? qk.threadMessages(msg.projectId, msg.threadId)
    : qk.timeline(msg.projectId);
  for (const [key] of qc.getQueriesData<MessagePages>({ queryKey: prefix })) {
    const channel = key[prefix.length] ?? 'all';
    const matches =
      channel === 'all' || (channel === 'agent' ? msg.agentVisible : !msg.agentVisible);
    qc.setQueryData<MessagePages>(key, (data) => {
      const clean = temporaryId ? removeMessage(data, temporaryId) : data;
      return matches ? upsertMessage(clean, msg) : removeMessage(clean, msg.id);
    });
  }
}

export function removeMessageCaches(
  qc: QueryClient,
  pid: string,
  threadId: string | null,
  id: string,
) {
  const key = threadId ? qk.threadMessages(pid, threadId) : qk.timeline(pid);
  qc.setQueriesData<MessagePages>({ queryKey: key }, (data) => removeMessage(data, id));
}

function threadMatches(thread: Thread, filter: ThreadListFilter): boolean {
  if (filter.kind && thread.kind !== filter.kind) return false;
  if (filter.bucket && thread.statusBucket !== filter.bucket) return false;
  if (filter.resolved !== undefined && thread.resolved !== filter.resolved) return false;
  return true;
}

export function upsertThread(qc: QueryClient, pid: string, thread: Thread) {
  qc.setQueryData(qk.thread(pid, thread.id), thread);
  for (const [key, data] of qc.getQueriesData<Thread[]>({ queryKey: qk.threadsRoot(pid) })) {
    if (!data) continue;
    const filter = (key[3] ?? {}) as ThreadListFilter;
    const exists = data.some((t) => t.id === thread.id);
    let next: Thread[];
    if (threadMatches(thread, filter)) next = upsertById(data, thread, true) ?? data;
    else if (exists) next = data.filter((t) => t.id !== thread.id);
    else continue;
    next = [...next].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    qc.setQueryData(key, next);
  }
}

/** 个人会话被删除：从所有线程列表里拿掉，详情缓存清掉。 */
export function removeThread(qc: QueryClient, pid: string, threadId: string) {
  for (const [key, data] of qc.getQueriesData<Thread[]>({ queryKey: qk.threadsRoot(pid) })) {
    if (data?.some((t) => t.id === threadId)) {
      qc.setQueryData(
        key,
        data.filter((t) => t.id !== threadId),
      );
    }
  }
  qc.removeQueries({ queryKey: qk.thread(pid, threadId), exact: true });
}

const THREAD_HREF = (pid: string, threadId: string | null, kind?: string) =>
  threadId ? `/p/${pid}/${kind === 'personal' ? 'workspace' : 'threads'}/${threadId}` : `/p/${pid}`;

function describe(
  event: AnyProjectEvent,
  qc: QueryClient,
): Omit<ActivityEntry, 'seq' | 'type' | 'actor' | 'threadId' | 'createdAt'> | null {
  const pid = event.projectId;
  switch (event.type) {
    case 'message.created': {
      const m = event.payload;
      if (m.kind === 'forward') return { text: tr('把个人会话转发给了协调者'), href: `/p/${pid}` };
      if (!m.threadId)
        return {
          text: m.agentVisible ? tr('在协作台发言') : tr('在团队讨论发言'),
          href: `/p/${pid}`,
        };
      const t = qc.getQueryData<Thread>(qk.thread(pid, m.threadId));
      if (t?.kind === 'personal') return null;
      return {
        text: tr('回复了线程{value}', { value: t ? tr('「{title}」', { title: t.title }) : '' }),
        href: THREAD_HREF(pid, m.threadId),
      };
    }
    case 'thread.created':
      if (event.payload.kind === 'personal') return null;
      return {
        text: tr('开了线程「{title}」', { title: event.payload.title }),
        href: THREAD_HREF(pid, event.payload.id),
      };
    case 'thread.updated':
      if (event.payload.kind === 'personal') return null;
      if (event.payload.resolved)
        return {
          text: tr('完成了线程「{title}」', { title: event.payload.title }),
          href: THREAD_HREF(pid, event.payload.id),
        };
      return null;
    case 'decision.updated':
      if (event.payload.state !== 'answered') return null;
      return {
        text: tr('回答了决策「{question}」', { question: event.payload.question }),
        href: THREAD_HREF(pid, event.payload.threadId),
      };
    case 'decision.created':
      return {
        text: tr('请人拍板：{question}', { question: event.payload.question }),
        href: THREAD_HREF(pid, event.payload.threadId),
      };
    case 'memory.updated':
      return {
        text: tr('更新了项目记忆 {path}', { path: event.payload.path }),
        href: `/p/${pid}/settings?tab=memory`,
      };
    case 'claim.created':
      return {
        text: tr('认领了 {resourceRef}：{intent}', {
          resourceRef: event.payload.resourceRef,
          intent: event.payload.intent,
        }),
        href: null,
      };
    case 'claim.conflict':
      return {
        text: tr('与他人的认领重叠：{resourceRef}', {
          resourceRef: event.payload.claim.resourceRef,
        }),
        href: null,
      };
    case 'member.joined':
      return { text: tr('加入了项目'), href: `/p/${pid}/settings?tab=members` };
    case 'document.created':
      return {
        text: tr('新建了文档「{title}」', { title: event.payload.title }),
        href: `/p/${pid}/docs/${event.payload.id}`,
      };
    case 'experiment.created':
      return {
        text: tr('新建了实验「{title}」', { title: event.payload.title }),
        href: `/p/${pid}/experiments/${event.payload.id}`,
      };
    case 'experiment.log_created':
      return {
        text: tr('追加了一条实验日志'),
        href: `/p/${pid}/experiments/${event.payload.experimentId}`,
      };
    case 'review.created':
      return {
        text: tr('请求审阅「{title}」', { title: event.payload.title }),
        href: `/p/${pid}/reviews/${event.payload.id}`,
      };
    case 'review.updated':
      if (event.payload.status === 'approved')
        return {
          text: tr('「{title}」已全部 LGTM', { title: event.payload.title }),
          href: `/p/${pid}/reviews/${event.payload.id}`,
        };
      if (event.payload.status === 'changes_requested')
        return {
          text: tr('「{title}」被要求修改', { title: event.payload.title }),
          href: `/p/${pid}/reviews/${event.payload.id}`,
        };
      return null;
    case 'report.created':
      return {
        text: tr('开始生成组会汇报「{title}」', { title: event.payload.title }),
        href: `/p/${pid}/reports/${event.payload.id}`,
      };
    case 'file.created':
      return { text: tr('上传了 {name}', { name: event.payload.name }), href: null };
    default:
      return null;
  }
}

export function applyEvent(qc: QueryClient, event: AnyProjectEvent, meId: string | null) {
  const pid = event.projectId;
  const store = useRealtimeStore.getState();

  switch (event.type) {
    case 'project.updated': {
      const p: Project = event.payload;
      qc.setQueryData(qk.project(pid), p);
      qc.setQueryData<(Project & { role: string })[]>(qk.projects, (list) =>
        list?.map((x) => (x.id === p.id ? { ...x, ...p } : x)),
      );
      void qc.invalidateQueries({ queryKey: qk.me });
      break;
    }
    case 'member.joined':
    case 'member.updated': {
      const m: ProjectMember = event.payload;
      qc.setQueryData<ProjectMember[]>(qk.members(pid), (list) => {
        if (!list) return list;
        const i = list.findIndex((x) => x.user.id === m.user.id);
        if (i === -1) return [...list, m];
        const next = list.slice();
        next[i] = m;
        return next;
      });
      if (m.user.id === meId) void qc.invalidateQueries({ queryKey: qk.me });
      break;
    }
    case 'member.removed': {
      const { userId } = event.payload;
      qc.setQueryData<ProjectMember[]>(qk.members(pid), (list) =>
        list?.filter((x) => x.user.id !== userId),
      );
      if (userId === meId) void qc.invalidateQueries({ queryKey: qk.me });
      break;
    }
    case 'message.created':
    case 'message.updated': {
      const m = event.payload;
      updateMessageCaches(qc, m);
      if (event.type === 'message.created' && !m.agentVisible) {
        const key = discussionKey(meId ?? undefined, pid, m.threadId);
        useDiscussionReading.getState().observe(key, m.id);
        if (m.author.id === meId) useDiscussionReading.getState().read(key, m.id);
      }
      if (m.author.kind === 'agent' && m.author.id) store.clearDraft(m.author.id);
      break;
    }
    case 'message.deleted': {
      const { id } = event.payload;
      qc.setQueriesData<MessagePages>({ queryKey: qk.timeline(pid) }, (d) => removeMessage(d, id));
      qc.setQueriesData<MessagePages>(
        { queryKey: ['p', pid, 'thread'], predicate: (q) => q.queryKey[4] === 'messages' },
        (d) => removeMessage(d, id),
      );
      break;
    }
    case 'thread.created':
    case 'thread.updated':
      upsertThread(qc, pid, event.payload);
      break;
    case 'thread.deleted':
      removeThread(qc, pid, event.payload.id);
      break;
    case 'decision.created':
    case 'decision.updated':
      qc.setQueryData(qk.decision(pid, event.payload.id), event.payload);
      break;
    case 'agent.updated': {
      const a: AgentSession = event.payload;
      qc.setQueryData<AgentSession[]>(qk.agents(pid), (list) => upsertById(list, a));
      if (a.status !== 'running' && a.status !== 'queued') store.clearDraft(a.id);
      break;
    }
    case 'agent.step': {
      const s: AgentStep = event.payload;
      qc.setQueryData<InfiniteData<Page<AgentStep>, string | null>>(
        qk.agentSteps(pid, s.sessionId),
        (data) => {
          if (!data) return data;
          const first = data.pages[0] ?? { items: [], nextCursor: null };
          if (first.items.some((x) => x.id === s.id)) return data;
          return {
            ...data,
            pages: [{ ...first, items: [s, ...first.items] }, ...data.pages.slice(1)],
          };
        },
      );
      break;
    }
    case 'memory.updated': {
      const f: MemoryFile = event.payload;
      const { content: _content, ...meta } = f;
      qc.setQueryData<Omit<MemoryFile, 'content'>[]>(qk.memory(pid), (list) => {
        if (!list) return list;
        const i = list.findIndex((x) => x.path === f.path);
        if (i === -1) return [...list, meta].sort((a, b) => a.path.localeCompare(b.path));
        const next = list.slice();
        next[i] = meta;
        return next;
      });
      qc.setQueryData(qk.memoryFile(pid, f.path), f);
      break;
    }
    case 'memory.deleted': {
      const { path } = event.payload;
      qc.setQueryData<Omit<MemoryFile, 'content'>[]>(qk.memory(pid), (list) =>
        list?.filter((x) => x.path !== path),
      );
      qc.removeQueries({ queryKey: qk.memoryFile(pid, path) });
      break;
    }
    case 'claim.created':
    case 'claim.updated': {
      const c: WorkClaim = event.payload;
      qc.setQueryData<WorkClaim[]>(qk.claims(pid), (list) =>
        c.status === 'active' ? upsertById(list, c, true) : removeById(list, c.id),
      );
      break;
    }
    case 'claim.conflict': {
      const { claim, conflictsWith } = event.payload;
      store.pushConflict(pid, { id: claim.id, claim, conflictsWith, at: event.createdAt });
      break;
    }
    case 'routine.created':
    case 'routine.updated':
      qc.setQueryData<Routine[]>(qk.routines(pid), (list) => upsertById(list, event.payload));
      break;
    case 'routine.deleted':
      qc.setQueryData<Routine[]>(qk.routines(pid), (list) => removeById(list, event.payload.id));
      break;
    case 'file.created':
    case 'file.updated':
    case 'file.deleted':
      void qc.invalidateQueries({ queryKey: qk.files(pid) });
      break;
    case 'inbox.created':
    case 'inbox.updated': {
      const item: InboxItem = event.payload;
      for (const done of [false, true]) {
        qc.setQueryData<InboxItem[]>(qk.inbox(pid, done), (list) => {
          if (!list) return list;
          const belongs = Boolean(item.doneAt) === done;
          return belongs ? upsertById(list, item, true) : removeById(list, item.id);
        });
      }
      break;
    }
    // harness：只广播项目作用域的变更；内置 + 项目 + 个人是合并视图，整体失效重新取
    case 'provider.updated':
    case 'provider.deleted':
    case 'mcp.updated':
    case 'mcp.deleted':
    case 'skill.updated':
    case 'skill.deleted':
    case 'command.updated':
    case 'command.deleted':
    case 'profile.updated':
    case 'profile.deleted':
      void invalidateHarness(qc, pid);
      break;
    default:
      break;
  }

  const summary = describe(event, qc);
  if (summary) {
    store.pushActivity(pid, {
      seq: event.seq,
      type: event.type,
      actor: event.actor,
      threadId: event.threadId,
      createdAt: event.createdAt,
      ...summary,
    });
  }
}
