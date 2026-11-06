import { useCallback } from 'react';
import { create } from 'zustand';

/** 同一浏览器会话内保留草稿；面板开合、标签/线程切换不清空输入，不写入持久存储。 */
const useDraftStore = create<{
  drafts: Record<string, string>;
  set: (key: string, value: string) => void;
}>()((set) => ({
  drafts: {},
  set: (key, value) => set((state) => ({ drafts: { ...state.drafts, [key]: value } })),
}));
export function useConversationDraft(
  projectId: string,
  threadId: string | null,
  userId: string | undefined,
  channel: 'agent' | 'team' = 'agent',
) {
  const key = draftKey(projectId, threadId, userId, channel);
  const draft = useDraftStore((state) => state.drafts[key] ?? '');
  const set = useDraftStore((state) => state.set);
  const setDraft = useCallback((value: string) => set(key, value), [key, set]);
  return [draft, setDraft] as const;
}

function draftKey(
  projectId: string,
  threadId: string | null,
  userId: string | undefined,
  channel: 'agent' | 'team',
) {
  return `${userId ?? 'anonymous'}:${projectId}:${threadId ?? 'coordinator'}:${channel}`;
}

export function appendAgentDraft(
  projectId: string,
  threadId: string | null,
  userId: string | undefined,
  quote: string,
) {
  const key = draftKey(projectId, threadId, userId, 'agent');
  const store = useDraftStore.getState();
  const current = store.drafts[key] ?? '';
  store.set(key, current ? `${current}\n\n${quote}` : quote);
}

export function clearSubmittedDraft(
  projectId: string,
  threadId: string | null,
  userId: string | undefined,
  channel: 'agent' | 'team',
  submitted: string,
) {
  const key = draftKey(projectId, threadId, userId, channel);
  const store = useDraftStore.getState();
  if (store.drafts[key] === submitted) store.set(key, '');
}
