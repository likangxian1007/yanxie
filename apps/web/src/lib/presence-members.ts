import type { PresenceState } from '@srh/shared';

type Target = { view: string; objectId: string | null };
const compare = (a: string, b: string) => a.localeCompare(b, 'zh-CN');

/** Keep connection priority deterministic without making heartbeat timestamps visible state. */
export function orderedPresence(members: PresenceState[]): PresenceState[] {
  return [...members].sort(
    (a, b) =>
      compare(a.userId, b.userId) ||
      compare(b.lastSeenAt, a.lastSeenAt) ||
      compare(`${a.view}/${a.objectId}/${a.activity}`, `${b.view}/${b.objectId}/${b.activity}`),
  );
}

export function samePresence(a: PresenceState[] | undefined, b: PresenceState[]): boolean {
  return (
    !!a &&
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i]!;
      return (
        p.userId === q.userId &&
        p.name === q.name &&
        p.avatarColor === q.avatarColor &&
        p.view === q.view &&
        p.objectId === q.objectId &&
        p.activity === q.activity
      );
    })
  );
}

export function presenceMembers(
  members: PresenceState[],
  selfId?: string,
  target?: Target,
): PresenceState[] {
  const byUser = new Map<string, PresenceState>();
  const local = (p: PresenceState) =>
    !!target && p.view === target.view && p.objectId === target.objectId;
  for (const p of orderedPresence(members)) {
    if (p.userId === selfId) continue;
    const previous = byUser.get(p.userId);
    if (!previous || (local(p) && !local(previous))) byUser.set(p.userId, p);
  }
  return [...byUser.values()].sort(
    (a, b) => compare(a.name, b.name) || compare(a.userId, b.userId),
  );
}
