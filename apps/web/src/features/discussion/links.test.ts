import { describe, expect, it } from 'vitest';
import { discussionParams, parseDiscussion } from './links';
import { resolveRefPath } from '@/lib/message-link';

describe('discussion navigation', () => {
  it('preserves filters while making auxiliary views mutually exclusive', () => {
    const next = discussionParams('?q=研究&thread=thr_A&threadTab=outputs&preview=doc:x', 'thr_B');
    expect(next.get('q')).toBe('研究');
    expect(next.get('discussion')).toBe('thr_B');
    expect(next.has('thread')).toBe(false);
    expect(next.has('preview')).toBe(false);
    expect(next.has('threadTab')).toBe(false);
    expect(parseDiscussion('project')).toBe('project');
    expect(parseDiscussion('thr_01ABC')).toBe('thr_01ABC');
    expect(parseDiscussion('../settings')).toBeNull();
  });
  it('resolves historical team references to their own discussion without changing visibility', async () => {
    const fetcher = {
      message: async () => ({ id: 'msg_A', threadId: 'thr_B', agentVisible: false }),
      thread: async () => ({ id: 'thr_B', kind: 'project' as const }),
      decision: async () => ({ messageId: 'msg_A', threadId: 'thr_B' }),
    };
    expect(await resolveRefPath('p', 'msg_A', fetcher)).toBe(
      '/p/p/threads/thr_B?discussion=thr_B#msg_A',
    );
  });
});
