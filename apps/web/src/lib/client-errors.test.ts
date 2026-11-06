import { describe, expect, it, vi } from 'vitest';
import { createClientErrorCollector } from './client-errors';

function setup(size = 3) {
  let t = 1_000_000;
  const report = vi.fn(() => Promise.resolve());
  const c = createClientErrorCollector({
    report,
    now: () => t,
    size,
    throttleMs: 60_000,
    route: () => '/p/x',
  });
  return { c, report, tick: (ms: number) => (t += ms) };
}

describe('client-errors collector', () => {
  it('keeps only the most recent N entries', () => {
    const { c } = setup(3);
    for (const m of ['a', 'b', 'c', 'd', 'e']) c.record({ message: m, source: 'error' });
    expect(c.recent().map((e) => e.message)).toEqual(['c', 'd', 'e']);
    expect(c.recent()[0]?.route).toBe('/p/x');
  });

  it('throttles reporting of the same message within the window', () => {
    const { c, report, tick } = setup();
    c.record({ message: 'boom', source: 'error' });
    c.record({ message: 'boom', source: 'error' });
    c.record({ message: 'other', source: 'rejection' });
    expect(report).toHaveBeenCalledTimes(2);
    tick(60_001);
    c.record({ message: 'boom', source: 'error' });
    expect(report).toHaveBeenCalledTimes(3);
    // 节流期间仍然进缓冲
    expect(c.recent()).toHaveLength(3);
  });

  it('reports api errors as warn and swallows reporter failures', async () => {
    const report = vi.fn(() => Promise.reject(new Error('offline')));
    const c = createClientErrorCollector({ report });
    c.record({ message: 'GET /x → 500 INTERNAL', source: 'api' });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
    await Promise.resolve();
    expect(c.recent()).toHaveLength(1);
  });

  it('clear resets buffer and throttle', () => {
    const { c, report } = setup();
    c.record({ message: 'x', source: 'error' });
    c.clear();
    c.record({ message: 'x', source: 'error' });
    expect(report).toHaveBeenCalledTimes(2);
    expect(c.recent()).toHaveLength(1);
  });
});
