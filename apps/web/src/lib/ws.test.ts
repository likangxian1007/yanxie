import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerFrame } from '@srh/shared';
import { RealtimeClient } from './ws';

/** 最小的 WebSocket 替身：记录发出的帧，可以手动触发 open / message / close。 */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  constructor(public url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  push(frame: ServerFrame) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
  drop() {
    this.readyState = 3;
    const ev = new Event('close') as Event & { code: number };
    ev.code = 1006;
    this.dispatchEvent(ev);
  }
}

function event(projectId: string, seq: number): ServerFrame {
  return {
    op: 'event',
    event: {
      id: `evt_${seq}`,
      projectId,
      seq,
      type: 'message.deleted',
      payload: { id: `msg_${seq}` },
      actor: { kind: 'system', id: null, name: '系统' },
      threadId: null,
      createdAt: new Date().toISOString(),
    },
  } as ServerFrame;
}

const subscribes = (s: FakeSocket) =>
  s.sent.filter((f) => (f as { op: string }).op === 'subscribe');

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient seq bookkeeping', () => {
  it('subscribes with the lower bound + replay, dedupes replayed events, resubscribes from last seen', () => {
    const client = new RealtimeClient({
      url: 'ws://x/ws',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    const seen: number[] = [];
    client.on('event', (f) => seen.push(f.event.seq));
    client.connect();
    client.subscribe('prj_a', 10);
    const s1 = FakeSocket.instances[0]!;
    s1.open();
    expect(subscribes(s1)).toEqual([
      { op: 'subscribe', projectId: 'prj_a', afterSeq: 10, replay: true },
    ]);

    // 服务端补发 11、12，然后 subscribed，再来一条重复的 12 和新的 13
    s1.push(event('prj_a', 11));
    s1.push(event('prj_a', 12));
    s1.push({ op: 'subscribed', projectId: 'prj_a', latestSeq: 12 });
    s1.push(event('prj_a', 12));
    s1.push(event('prj_a', 13));
    expect(seen).toEqual([11, 12, 13]);

    // 断线重连：从 13 继续补发
    s1.drop();
    vi.advanceTimersByTime(20_000);
    const s2 = FakeSocket.instances[1]!;
    s2.open();
    expect(subscribes(s2)).toEqual([
      { op: 'subscribe', projectId: 'prj_a', afterSeq: 13, replay: true },
    ]);
    client.disconnect();
  });

  it('leaving and re-entering a project replays from where it stopped', () => {
    const client = new RealtimeClient({
      url: 'ws://x/ws',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    client.connect();
    const s = FakeSocket.instances[0]!;
    s.open();
    client.subscribe('prj_a', 3);
    s.push(event('prj_a', 4));
    client.unsubscribe('prj_a');
    expect(client.seqOf('prj_a')).toBe(4);
    client.subscribe('prj_a', 50);
    expect(subscribes(s).at(-1)).toEqual({
      op: 'subscribe',
      projectId: 'prj_a',
      afterSeq: 4,
      replay: true,
    });
    client.disconnect();
  });
});
