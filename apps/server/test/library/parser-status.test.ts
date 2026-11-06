import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { grobidParser } from '../../src/modules/library/parser';

afterEach(() => vi.unstubAllGlobals());

describe('GROBID 就绪检查', () => {
  it.each(['false', '<html>proxy</html>', ''])('HTTP 200 返回 %j 时不误报已连接', async (body) => {
    const fetch = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal('fetch', fetch);
    expect(await grobidParser(loadConfig({})).probe()).toEqual({ reachable: false, version: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('明确就绪后读取版本；版本接口故障不影响就绪状态', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(' true\n'))
      .mockResolvedValueOnce(new Response('{"version":"0.9.1"}'))
      .mockResolvedValueOnce(new Response('true'))
      .mockRejectedValueOnce(new Error('version unavailable'));
    vi.stubGlobal('fetch', fetch);
    const parser = grobidParser(loadConfig({}));
    expect(await parser.probe()).toEqual({ reachable: true, version: '0.9.1' });
    expect(await parser.probe()).toEqual({ reachable: true, version: null });
  });
});
