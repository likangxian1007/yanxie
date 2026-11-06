import { create } from 'zustand';

interface ReadingState {
  latest: Record<string, string>;
  seen: Record<string, string>;
  observe: (key: string, id: string) => void;
  read: (key: string, id: string) => void;
}
export const discussionKey = (
  userId: string | undefined,
  projectId: string,
  threadId: string | null,
) => `${userId ?? 'anonymous'}:${projectId}:${threadId ?? 'project'}`;
const bounded = (values: Record<string, string>, key: string, value: string) =>
  Object.fromEntries(
    [...Object.entries(values).filter(([k]) => k !== key), [key, value]].slice(-100),
  );
export const useDiscussionReading = create<ReadingState>()((set) => ({
  latest: {},
  seen: {},
  observe: (key, id) =>
    set((s) => (s.latest[key] === id ? s : { latest: bounded(s.latest, key, id) })),
  read: (key, id) => set((s) => (s.seen[key] === id ? s : { seen: bounded(s.seen, key, id) })),
}));
