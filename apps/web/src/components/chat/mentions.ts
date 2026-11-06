import type { MessageMention } from '@srh/shared';

/** 保留未被编辑触碰的提及，并同步后方范围；名字内的修改会使提及退回普通文字。 */
export function rebaseMentions(
  before: string,
  after: string,
  mentions: MessageMention[],
): MessageMention[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const end = before.length - tail;
  const delta = after.length - before.length;
  return mentions
    .flatMap((m) => {
      if (m.end <= start) return [m];
      if (m.start >= end) return [{ ...m, start: m.start + delta, end: m.end + delta }];
      return [];
    })
    .filter((m) => after.slice(m.start, m.end) === `@${m.label}`);
}

export function trimmedMentions(body: string, mentions: MessageMention[]) {
  const leading = body.length - body.trimStart().length;
  const trimmed = body.trim();
  return mentions
    .map((m) => ({ ...m, start: m.start - leading, end: m.end - leading }))
    .filter((m) => m.start >= 0 && trimmed.slice(m.start, m.end) === `@${m.label}`);
}

export function mentionQuery(body: string, caret: number) {
  const prefix = body.slice(0, caret);
  const match = /(?:^|[\s(（])@([^\s]{0,80})$/u.exec(prefix);
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! };
}
