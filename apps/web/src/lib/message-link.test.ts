import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findRefElement,
  flashElement,
  goToRefPath,
  messagePath,
  parseLinkRef,
  resolveRefPath,
  type RefFetcher,
} from './message-link';
import { internalHref } from './outputs';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('parseLinkRef / internalHref', () => {
  it('recognizes #msg_ and #dec_ only', () => {
    expect(parseLinkRef('#msg_01ABC')).toEqual({ kind: 'message', id: 'msg_01ABC' });
    expect(parseLinkRef('dec_01ABC')).toEqual({ kind: 'decision', id: 'dec_01ABC' });
    expect(parseLinkRef('#thr_01ABC')).toBeNull();
    expect(parseLinkRef('#msg_')).toBeNull();
    expect(parseLinkRef('#本周进展')).toBeNull();
  });

  it('internalHref sends msg_ / dec_ to the go page', () => {
    expect(internalHref('p1', '#msg_01ABC')).toBe('/p/p1/go/msg_01ABC');
    expect(internalHref('p1', '#dec_01ABC')).toBe(goToRefPath('p1', 'dec_01ABC'));
    expect(internalHref('p1', '#thr_1')).toBe('/p/p1/threads/thr_1');
    expect(internalHref('p1', '#xyz_1')).toBeNull();
  });
});

describe('messagePath', () => {
  it('timeline / project thread / personal session', () => {
    expect(messagePath('p1', 'msg_1', null)).toBe('/p/p1#msg_1');
    expect(messagePath('p1', 'msg_1', { id: 'thr_1', kind: 'project' })).toBe(
      '/p/p1/threads/thr_1#msg_1',
    );
    expect(messagePath('p1', 'msg_1', { id: 'thr_2', kind: 'personal' })).toBe(
      '/p/p1/workspace/thr_2#msg_1',
    );
  });
});

describe('resolveRefPath', () => {
  const fetcher = (over: Partial<RefFetcher> = {}): RefFetcher => ({
    message: vi.fn(async (id: string) => ({ id, threadId: 'thr_1' })),
    decision: vi.fn(async () => ({ messageId: 'msg_card', threadId: null })),
    thread: vi.fn(async (id: string) => ({ id, kind: 'project' as const })),
    ...over,
  });

  it('message in a thread → thread page with hash', async () => {
    const f = fetcher();
    await expect(resolveRefPath('p1', '#msg_9', f)).resolves.toBe('/p/p1/threads/thr_1#msg_9');
    expect(f.thread).toHaveBeenCalledWith('thr_1');
  });

  it('decision on the timeline → timeline with the card message hash, no thread lookup', async () => {
    const f = fetcher();
    await expect(resolveRefPath('p1', 'dec_1', f)).resolves.toBe('/p/p1#msg_card');
    expect(f.thread).not.toHaveBeenCalled();
  });

  it('propagates lookup errors and rejects unknown refs', async () => {
    const f = fetcher({ message: () => Promise.reject(new Error('404')) });
    await expect(resolveRefPath('p1', 'msg_1', f)).rejects.toThrow('404');
    await expect(resolveRefPath('p1', 'thr_1', f)).rejects.toThrow();
  });
});

describe('findRefElement / flashElement', () => {
  it('finds the message, or the message holding the decision card', () => {
    document.body.innerHTML = `
      <article id="msg_a">a</article>
      <article id="msg_b"><div data-decision-id="dec_1">card</div></article>`;
    expect(findRefElement('#msg_a')?.id).toBe('msg_a');
    expect(findRefElement('dec_1')?.id).toBe('msg_b');
    expect(findRefElement('msg_missing')).toBeNull();
  });

  it('flash scrolls and highlights briefly', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<article id="msg_a">a</article>';
    const el = document.getElementById('msg_a')!;
    el.scrollIntoView = vi.fn();
    flashElement(el, true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(el.hasAttribute('data-flash')).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(el.hasAttribute('data-flash')).toBe(false);
  });
});
