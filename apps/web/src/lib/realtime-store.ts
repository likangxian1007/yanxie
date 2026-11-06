import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { orderedPresence, samePresence } from './presence-members';
import type { ActorRef, AnyProjectEvent, PresenceState, WorkClaim } from '@srh/shared';
import type { RealtimeStatus } from './ws';

/**
 * 实时状态（不进 react-query 的那部分）：连接状态、在线成员、agent 流式草稿、最近动态、冲突预警。
 */

export interface AgentDraft {
  sessionId: string;
  threadId: string | null;
  turnId: string;
  text: string;
  updatedAt: number;
}

export interface ActivityEntry {
  seq: number;
  type: AnyProjectEvent['type'];
  actor: ActorRef;
  threadId: string | null;
  createdAt: string;
  /** 一句话中文描述（不含操作者名字） */
  text: string;
  href: string | null;
}

export interface ConflictAlert {
  id: string;
  claim: WorkClaim;
  conflictsWith: WorkClaim[];
  at: string;
}

const MAX_ACTIVITY = 60;

interface RealtimeState {
  status: RealtimeStatus;
  presence: Record<string, PresenceState[]>;
  drafts: Record<string, AgentDraft>;
  activity: Record<string, ActivityEntry[]>;
  conflicts: Record<string, ConflictAlert[]>;
  setStatus: (status: RealtimeStatus) => void;
  clearPresence: (projectId: string) => void;
  setPresence: (projectId: string, members: PresenceState[]) => void;
  appendDelta: (d: Omit<AgentDraft, 'text' | 'updatedAt'> & { delta: string }) => void;
  clearDraft: (sessionId: string) => void;
  pushActivity: (projectId: string, entry: ActivityEntry) => void;
  pushConflict: (projectId: string, alert: ConflictAlert) => void;
  dismissConflict: (projectId: string, id: string) => void;
}

export const useRealtimeStore = create<RealtimeState>()((set) => ({
  status: 'idle',
  presence: {},
  drafts: {},
  activity: {},
  conflicts: {},
  setStatus: (status) =>
    set((s) =>
      status === s.status ? s : { status, ...(status !== 'open' ? { presence: {} } : {}) },
    ),
  clearPresence: (projectId) =>
    set((s) => {
      if (!Object.hasOwn(s.presence, projectId)) return s;
      const presence = { ...s.presence };
      delete presence[projectId];
      return { presence };
    }),
  setPresence: (projectId, members) =>
    set((s) => {
      const next = orderedPresence(members);
      return samePresence(s.presence[projectId], next)
        ? s
        : { presence: { ...s.presence, [projectId]: next } };
    }),
  appendDelta: ({ sessionId, threadId, turnId, delta }) =>
    set((s) => {
      const prev = s.drafts[sessionId];
      const text = prev && prev.turnId === turnId ? prev.text + delta : delta;
      return {
        drafts: {
          ...s.drafts,
          [sessionId]: { sessionId, threadId, turnId, text, updatedAt: Date.now() },
        },
      };
    }),
  clearDraft: (sessionId) =>
    set((s) => {
      if (!s.drafts[sessionId]) return s;
      const drafts = { ...s.drafts };
      delete drafts[sessionId];
      return { drafts };
    }),
  pushActivity: (projectId, entry) =>
    set((s) => {
      const list = s.activity[projectId] ?? [];
      if (list.some((e) => e.seq === entry.seq)) return s;
      return {
        activity: { ...s.activity, [projectId]: [entry, ...list].slice(0, MAX_ACTIVITY) },
      };
    }),
  pushConflict: (projectId, alert) =>
    set((s) => {
      const list = (s.conflicts[projectId] ?? []).filter((c) => c.id !== alert.id);
      return { conflicts: { ...s.conflicts, [projectId]: [alert, ...list].slice(0, 20) } };
    }),
  dismissConflict: (projectId, id) =>
    set((s) => ({
      conflicts: {
        ...s.conflicts,
        [projectId]: (s.conflicts[projectId] ?? []).filter((c) => c.id !== id),
      },
    })),
}));

const EMPTY_PRESENCE: PresenceState[] = [];
const EMPTY_ACTIVITY: ActivityEntry[] = [];
const EMPTY_CONFLICTS: ConflictAlert[] = [];

export function usePresence(projectId: string): PresenceState[] {
  return useRealtimeStore((s) => s.presence[projectId] ?? EMPTY_PRESENCE);
}

export function useActivity(projectId: string): ActivityEntry[] {
  return useRealtimeStore((s) => s.activity[projectId] ?? EMPTY_ACTIVITY);
}

export function useConflicts(projectId: string): ConflictAlert[] {
  return useRealtimeStore((s) => s.conflicts[projectId] ?? EMPTY_CONFLICTS);
}

/** 某个线程（threadId=null 为时间线）上正在流式输出的 agent 草稿。 */
export function useDraftsFor(threadId: string | null): AgentDraft[] {
  return useRealtimeStore(
    useShallow((s) =>
      Object.values(s.drafts).filter((d) => d.threadId === threadId && d.text.length > 0),
    ),
  );
}
