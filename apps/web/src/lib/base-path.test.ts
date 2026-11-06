import { describe, expect, it } from 'vitest';
import { resolveApiUrl, resolveApiUrlFor } from './api';
import { BASE, joinBase, normalizeBase, withBase } from './base-path';

describe('normalizeBase', () => {
  it('根路径归一成空串，子路径去掉结尾斜杠', () => {
    expect(normalizeBase('/')).toBe('');
    expect(normalizeBase(undefined)).toBe('');
    expect(normalizeBase('./')).toBe('');
    expect(normalizeBase('/app/')).toBe('/app');
    expect(normalizeBase('app')).toBe('/app');
    expect(normalizeBase('/a/b//')).toBe('/a/b');
  });
});

describe('joinBase', () => {
  it('给站内绝对路径加前缀', () => {
    expect(joinBase('/app', '/p/prj_1')).toBe('/app/p/prj_1');
    expect(joinBase('/app', '/')).toBe('/app/');
    expect(joinBase('/app', '/ws')).toBe('/app/ws');
  });

  it('外部地址、锚点、相对路径与已带前缀的路径原样返回', () => {
    expect(joinBase('/app', 'https://x.org/a')).toBe('https://x.org/a');
    expect(joinBase('/app', '//cdn.x.org/a')).toBe('//cdn.x.org/a');
    expect(joinBase('/app', '#msg_1')).toBe('#msg_1');
    expect(joinBase('/app', 'data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    expect(joinBase('/app', '/app/p/1')).toBe('/app/p/1');
    expect(joinBase('/app', '/app')).toBe('/app');
    expect(joinBase('/app', '/apple')).toBe('/app/apple');
  });

  it('根路径部署时不改动', () => {
    expect(joinBase('', '/p/prj_1')).toBe('/p/prj_1');
  });
});

describe('resolveApiUrlFor', () => {
  it('子路径部署时 REST 地址带前缀', () => {
    expect(resolveApiUrlFor('/app', '/projects')).toBe('/app/api/v1/projects');
    expect(resolveApiUrlFor('/app', '/api/health')).toBe('/app/api/health');
    expect(resolveApiUrlFor('/app', '/projects/p1/files', { a: 1, b: null })).toBe(
      '/app/api/v1/projects/p1/files?a=1',
    );
  });

  it('根路径部署时与原来一致', () => {
    expect(resolveApiUrlFor('', '/projects')).toBe('/api/v1/projects');
    expect(resolveApiUrlFor('', 'projects', { q: 'x y' })).toBe('/api/v1/projects?q=x+y');
  });
});

describe('测试环境默认根路径', () => {
  it('BASE 为空，withBase / resolveApiUrl 不加前缀', () => {
    expect(BASE).toBe('');
    expect(withBase('/p/1')).toBe('/p/1');
    expect(resolveApiUrl('/projects')).toBe('/api/v1/projects');
  });
});
