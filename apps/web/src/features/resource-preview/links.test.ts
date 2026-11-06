import { describe, expect, it } from 'vitest';
import { parsePreview, previewHref, previewReturnTo, resourcePageHref } from './links';

describe('资源预览链接', () => {
  it.each(['doc', 'paper', 'experiment', 'review', 'report'] as const)(
    '解析 %s 类型且保留列表上下文',
    (type) => {
      expect(parsePreview(`${type}:id_a`)).toEqual({ type, id: 'id_a' });
      const href = previewHref(
        { pathname: '/p/a/docs', search: '?tab=mine&q=研究&thread=thr_a&threadTab=outputs' },
        type,
        'id_a',
      );
      const url = new URL(href, 'https://test.local');
      expect(url.searchParams.get('tab')).toBe('mine');
      expect(url.searchParams.get('q')).toBe('研究');
      expect(url.searchParams.has('thread')).toBe(false);
      expect(url.searchParams.has('threadTab')).toBe(false);
      expect(url.searchParams.get('preview')).toBe(`${type}:id_a`);
    },
  );
  it.each([null, '', 'unknown:id', 'doc:', 'doc:a/b', 'paper:a:b'])('忽略无效值 %s', (value) =>
    expect(parsePreview(value)).toBeNull(),
  );
  it('完整页保留可直接恢复的 returnTo', () => {
    const returnTo = previewReturnTo({
      pathname: '/p/a/docs',
      search: '?tab=all&q=abc&preview=doc:a',
    });
    const full = new URL(
      resourcePageHref('a', { type: 'doc', id: 'a' }, returnTo),
      'https://test.local',
    );
    expect(full.pathname).toBe('/p/a/docs/a');
    expect(full.searchParams.get('returnTo')).toBe('/p/a/docs?tab=all&q=abc');
  });
});
