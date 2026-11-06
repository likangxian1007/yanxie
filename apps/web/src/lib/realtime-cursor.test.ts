import { describe, expect, it } from 'vitest';
import { SeqCursors } from './realtime-cursor';

describe('SeqCursors', () => {
  it('first subscribe with a lower bound asks the server to replay from it (even 0)', () => {
    const c = new SeqCursors();
    expect(c.begin('p1', 42)).toEqual({ afterSeq: 42, replay: true });
    const fresh = new SeqCursors();
    expect(fresh.begin('p1', 0)).toEqual({ afterSeq: 0, replay: true });
  });

  it('without any bound falls back to live-only', () => {
    const c = new SeqCursors();
    expect(c.begin('p1')).toEqual({ afterSeq: 0, replay: false });
    // subscribed 之后就有下界了，重连时补发
    c.onCaughtUp('p1', 7);
    expect(c.argsFor('p1')).toEqual({ afterSeq: 7, replay: true });
  });

  it('tracks the max seen seq and drops duplicates / old events', () => {
    const c = new SeqCursors();
    c.begin('p1', 10);
    expect(c.onEvent('p1', 11)).toBe(true);
    expect(c.onEvent('p1', 12)).toBe(true);
    expect(c.onEvent('p1', 12)).toBe(false);
    expect(c.onEvent('p1', 9)).toBe(false);
    expect(c.seqOf('p1')).toBe(12);
    // 没订阅的项目不过滤
    expect(c.onEvent('other', 1)).toBe(true);
  });

  it('replayed events between the bound and subscribed all pass, then subscribed never moves backwards', () => {
    const c = new SeqCursors();
    c.begin('p1', 5);
    for (const seq of [6, 7, 8]) expect(c.onEvent('p1', seq)).toBe(true);
    c.onCaughtUp('p1', 8);
    expect(c.seqOf('p1')).toBe(8);
    c.onCaughtUp('p1', 3);
    expect(c.seqOf('p1')).toBe(8);
  });

  it('reconnect resubscribes from the last seen seq', () => {
    const c = new SeqCursors();
    c.begin('p1', 5);
    c.begin('p2');
    c.onEvent('p1', 9);
    expect(c.entries()).toEqual([
      ['p1', { afterSeq: 9, replay: true }],
      ['p2', { afterSeq: 0, replay: false }],
    ]);
  });

  it('a repeated subscribe while active keeps the current cursor', () => {
    const c = new SeqCursors();
    c.begin('p1', 5);
    c.onEvent('p1', 9);
    expect(c.begin('p1', 2)).toEqual({ afterSeq: 9, replay: true });
    expect(c.begin('p1', 20)).toEqual({ afterSeq: 9, replay: true });
  });

  it('re-entering a project replays from where the cached data stopped (min of bounds)', () => {
    const c = new SeqCursors();
    c.begin('p1', 5);
    c.onEvent('p1', 9);
    expect(c.end('p1')).toBe(true);
    expect(c.end('p1')).toBe(false);
    expect(c.isActive('p1')).toBe(false);
    expect(c.seqOf('p1')).toBe(9);
    // me 后来刷新到 30，但缓存里的数据只到 9：从 9 补发
    expect(c.begin('p1', 30)).toEqual({ afterSeq: 9, replay: true });
    c.end('p1');
    // me 比缓存还旧：从更早的 me 补发
    expect(c.begin('p1', 4)).toEqual({ afterSeq: 4, replay: true });
  });

  it('ignores invalid bounds', () => {
    const c = new SeqCursors();
    expect(c.begin('p1', Number.NaN)).toEqual({ afterSeq: 0, replay: false });
    c.end('p1');
    expect(c.begin('p2', -1)).toEqual({ afterSeq: 0, replay: false });
  });

  it('resync jumps to latest', () => {
    const c = new SeqCursors();
    c.begin('p1', 1);
    c.onCaughtUp('p1', 5000);
    expect(c.onEvent('p1', 4000)).toBe(false);
    expect(c.onEvent('p1', 5001)).toBe(true);
  });
});
