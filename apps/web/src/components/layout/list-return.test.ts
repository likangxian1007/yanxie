import { describe, expect, it } from 'vitest';
import { listReturnHref } from './list-return';
describe('safe list return', () => {
  it('retains filters but removes preview selection', () =>
    expect(
      listReturnHref(
        '/p/a/docs',
        '?returnTo=' + encodeURIComponent('/p/a/docs?q=notes&preview=doc:1'),
      ),
    ).toBe('/p/a/docs?q=notes'));
  it.each(['https://evil.test/p/a/docs', '//evil.test/p/a/docs', '/p/b/docs', '/p/a/docs/1'])(
    'rejects %s',
    (value) =>
      expect(listReturnHref('/p/a/docs', '?returnTo=' + encodeURIComponent(value))).toBe(
        '/p/a/docs',
      ),
  );
});
