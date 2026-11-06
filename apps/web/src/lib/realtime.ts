import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AnyProjectEvent, EphemeralPayload } from '@srh/shared';
import { applyEvent } from './apply-event';
import { qk } from './query-keys';
import { useRealtimeStore } from './realtime-store';
import type { MeResponse } from './session';
import { realtime } from './ws';
import { tr } from '@/lib/i18n';

export { realtime };

/** /auth/me 里某项目的 eventSeq；老服务端没有这个字段时返回 undefined（退回只收实时事件）。 */
export function eventSeqFromMe(me: MeResponse | undefined, projectId: string): number | undefined {
  const seq = me?.projects.find((p) => p.id === projectId)?.eventSeq;
  return typeof seq === 'number' ? seq : undefined;
}

/**
 * 项目级实时接入（AppShell 里调用一次）：连接 /ws、订阅项目、把事件写进缓存、
 * 收流式草稿与在线状态，并随路由上报自己的 presence。
 */
export function useProjectRealtime(projectId: string, meId: string | null) {
  const qc = useQueryClient();
  const location = useLocation();
  const presenceRef = useRef(presenceFromPath(location.pathname));

  useEffect(() => {
    const store = useRealtimeStore.getState();
    const accessChanged = () => {
      realtime.unsubscribe(projectId);
      store.clearPresence(projectId);
      void qc.cancelQueries({ queryKey: qk.projectRoot(projectId) }).then(() => {
        qc.removeQueries({ queryKey: qk.projectRoot(projectId) });
      });
      void qc.invalidateQueries({ queryKey: qk.me });
    };
    const offStatus = realtime.onStatus((s) => {
      store.setStatus(s);
      if (s === 'unauthorized') accessChanged();
    });
    store.setStatus(realtime.status);
    store.clearPresence(projectId);
    realtime.connect();
    // 补发下界：/auth/me 返回时该项目的最新 seq。AppShell 要等 me 才渲染各页面，
    // 所以页面的 REST 数据一定不早于它；订阅建立前发生的事件由服务端从这里补发。
    realtime.subscribe(projectId, eventSeqFromMe(qc.getQueryData<MeResponse>(qk.me), projectId));

    const offs = [
      offStatus,
      realtime.on('error', (frame) => {
        if (frame.code === 'forbidden' || frame.code === 'unauthorized') accessChanged();
      }),
      realtime.on('event', ({ event }) => {
        if (event.projectId !== projectId) return;
        applyEvent(qc, event, meId);
      }),
      realtime.on('ephemeral', (frame) => {
        if (frame.projectId !== projectId || frame.type !== 'agent.delta') return;
        const p = frame.payload as EphemeralPayload<'agent.delta'>;
        useRealtimeStore.getState().appendDelta(p);
      }),
      realtime.on('presence', (frame) => {
        if (frame.projectId !== projectId) return;
        useRealtimeStore.getState().setPresence(projectId, frame.members);
      }),
      realtime.on('resync', (frame) => {
        if (frame.projectId !== projectId) return;
        void qc.invalidateQueries({ queryKey: qk.projectRoot(projectId) });
        void qc.invalidateQueries({ queryKey: qk.inboxRoot(projectId) });
      }),
      realtime.on('subscribed', (frame) => {
        if (frame.projectId !== projectId) return;
        realtime.send({ op: 'presence', projectId, ...presenceRef.current });
      }),
    ];
    return () => {
      for (const off of offs) off();
      realtime.unsubscribe(projectId);
    };
  }, [projectId, meId, qc]);

  useEffect(() => {
    presenceRef.current = presenceFromPath(location.pathname);
    realtime.send({ op: 'presence', projectId, ...presenceRef.current });
  }, [location.pathname, projectId]);
}

/** 上报“正在输入 / 正在编辑”（不传则回到 viewing）。 */
export function reportActivity(projectId: string, activity: 'viewing' | 'typing' | 'editing') {
  const base = presenceFromPath(window.location.pathname);
  realtime.send({ op: 'presence', projectId, ...base, activity });
}

/**
 * 输入框用：返回一个“我在输入”回调。最多 3 秒上报一次 typing，停手 4 秒后回到 viewing。
 */
export function useTypingReporter(projectId: string): () => void {
  const last = useRef(0);
  const idle = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (idle.current !== undefined) {
        window.clearTimeout(idle.current);
        reportActivity(projectId, 'viewing');
      }
    },
    [projectId],
  );
  return useCallback(() => {
    const now = Date.now();
    if (now - last.current > 3000) {
      last.current = now;
      reportActivity(projectId, 'typing');
    }
    if (idle.current !== undefined) window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      idle.current = undefined;
      last.current = 0;
      reportActivity(projectId, 'viewing');
    }, 4000);
  }, [projectId]);
}

/**
 * 订阅某项目的每一条事件（协作功能用来更新自己的缓存）。handler 不必 memo。
 * AppShell 已经统一连接与订阅，这里只是加一个监听。
 */
export function useProjectEvent(
  projectId: string | undefined,
  handler: (event: AnyProjectEvent) => void,
) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!projectId) return;
    return realtime.on('event', ({ event }) => {
      if (event.projectId === projectId) ref.current(event);
    });
  }, [projectId]);
}

export interface PresenceTarget {
  view: string;
  objectId: string | null;
}

/** 从路径推出 presence 的 view / objectId：/p/:pid/threads/:id → thread + id */
export function presenceFromPath(pathname: string): PresenceTarget {
  const parts = pathname.split('/').filter(Boolean);
  // ['p', pid, section?, id?]
  const section = parts[2] ?? '';
  const id = parts[3] ?? null;
  const VIEW: Record<string, string> = {
    '': 'timeline',
    workspace: 'workspace',
    threads: id ? 'thread' : 'threads',
    docs: id ? 'document' : 'docs',
    library: id ? 'paper' : 'library',
    board: 'board',
    todos: 'todos',
    tasks: 'tasks',
    notebooks: id ? 'notebook' : 'notebooks',
    research: id ? 'research_record' : 'research',
    reviews: id ? 'review' : 'reviews',
    proposals: 'proposal',
    reports: id ? 'report' : 'reports',
    plans: 'plans',
    inbox: 'inbox',
    settings: 'settings',
    help: 'help',
  };
  const view = Object.hasOwn(VIEW, section) ? VIEW[section]! : 'unknown';
  return { view, objectId: section === 'workspace' || view === 'unknown' ? null : id };
}

/** presence.view 的中文：“正在看 协作台” */
export const VIEW_LABEL: Record<string, string> = {
  timeline: tr('协作台'),
  workspace: tr('我的工作区'),
  threads: tr('线程列表'),
  thread: tr('线程'),
  docs: tr('文档'),
  document: tr('文档'),
  library: tr('文献库'),
  paper: tr('论文'),
  board: tr('看板'),
  todos: tr('待办'),
  tasks: tr('任务'),
  notebooks: 'Notebook',
  notebook: 'Notebook',
  research: tr('研究空间'),
  research_record: tr('研究空间'),
  reviews: tr('审阅'),
  review: tr('审阅'),
  proposal: tr('改动提案'),
  reports: tr('组会汇报'),
  report: tr('组会汇报'),
  plans: tr('方案与依据'),
  inbox: tr('待我处理'),
  settings: tr('设置'),
  help: tr('帮助中心'),
};
