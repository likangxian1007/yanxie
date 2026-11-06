import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import type { DocumentMeta } from '@srh/shared';
import { ApiRequestError } from '@/lib/api';
import type * as ApiModule from '@/lib/api';
import { contentExtensions } from '../extensions';
import { RichEnvContext } from '../context';
import { mockLayoutApis } from '../test-utils';
import { embedProblem, isLiveKind } from './lib';
import { embeddableDocs } from './DocPicker';

beforeAll(mockLayoutApis);

const metaById = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(async (path: string) => {
        const id = /\/docs\/([^/?]+)$/u.exec(path)?.[1];
        const hit = id ? metaById.get(id) : undefined;
        if (hit instanceof Error) throw hit;
        if (hit) return hit;
        if (path.startsWith('/me') || path.startsWith('/auth/me')) {
          return {
            user: { id: 'u', name: '张三' },
            projects: [{ id: 'p1', role: 'member' }],
          };
        }
        return [];
      }),
    },
  };
});

function meta(p: Partial<DocumentMeta> & { id: string }): DocumentMeta {
  return {
    projectId: 'p1',
    kind: 'sheet',
    title: '实验数据',
    excerpt: '',
    createdBy: { kind: 'user', id: 'u', name: '张三' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    ...p,
  } as DocumentMeta;
}

function Host({ html }: { html: string }) {
  const editor = useEditor({ extensions: contentExtensions(), content: html, editable: false });
  return <EditorContent editor={editor} />;
}

function renderDoc(html: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RichEnvContext.Provider value={{ projectId: 'p1', docId: 'self', editable: false }}>
          {children}
        </RichEnvContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(wrap(<Host html={html} />));
}

const embed = (id: string, kind = 'sheet', title = '实验数据') =>
  `<div data-type="doc-embed" docid="${id}" kind="${kind}" title="${title}"></div>`;

describe('内嵌文档块的降级', () => {
  it('原文档被删或没有权限（404 / 403）→ 链接卡片，仍可在新页面打开', async () => {
    metaById.set(
      'gone',
      new ApiRequestError({ status: 404, code: 'not_found', message: '文档不存在' }),
    );
    renderDoc(embed('gone'));
    expect(await screen.findByText('原文档已被删除，或者你没有权限查看。')).toBeInTheDocument();
    expect(screen.getByText('实验数据')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '在新页面打开' })).toHaveAttribute(
      'href',
      '/p/p1/docs/gone',
    );
  });

  it('网络错误 → 可以重试', { timeout: 10_000 }, async () => {
    metaById.set('flaky', new ApiRequestError({ status: 500, code: 'internal', message: 'x' }));
    renderDoc(embed('flaky'));
    // useDocMeta 对非 404 错误会重试两次（1s + 2s）
    expect(
      await screen.findByText('内嵌文档没有加载出来。', undefined, { timeout: 6000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('富文本 / LaTeX → 摘要卡片；标题以原文档为准', async () => {
    metaById.set(
      'd2',
      meta({ id: 'd2', kind: 'doc', title: '研究计划（新）', excerpt: '目标与方法' }),
    );
    renderDoc(embed('d2', 'doc', '研究计划'));
    expect(await screen.findByText('目标与方法')).toBeInTheDocument();
    expect(screen.getByText('研究计划（新）')).toBeInTheDocument();
    expect(screen.getByText(/打开文档/)).toBeInTheDocument();
  });

  it('表格：没进入视口前只显示骨架（不建立协同连接）', async () => {
    metaById.set('s1', meta({ id: 's1' }));
    renderDoc(embed('s1'));
    await waitFor(() => expect(screen.getByLabelText('正在连接内嵌文档')).toBeInTheDocument());
  });

  it('纯函数：错误分类、类型、可嵌入列表', () => {
    expect(embedProblem(new ApiRequestError({ status: 403, code: 'forbidden', message: '' }))).toBe(
      'gone',
    );
    expect(embedProblem(new Error('x'))).toBe('error');
    expect(isLiveKind('sheet') && isLiveKind('slides')).toBe(true);
    expect(isLiveKind('doc') || isLiveKind('latex')).toBe(false);
    const docs = [
      meta({ id: 'a', title: '数据 A' }),
      meta({ id: 'self', title: '自己' }),
      meta({ id: 'b', title: '归档', archivedAt: '2026-01-02T00:00:00.000Z' }),
      meta({ id: 'c', kind: 'slides', title: '组会' }),
    ];
    expect(embeddableDocs(docs, 'sheet', 'self', '').map((d) => d.id)).toEqual(['a']);
    expect(embeddableDocs(docs, 'sheet', 'x', '数据').map((d) => d.id)).toEqual(['a']);
    expect(embeddableDocs(docs, 'slides', 'x', '').map((d) => d.id)).toEqual(['c']);
  });
});

// 保证测试文件里 Editor 的 import 被使用（headless 构造也能装上自定义节点）
it('headless 编辑器能装上自定义节点', () => {
  const e = new Editor({ extensions: contentExtensions(), content: embed('x') });
  expect(e.getJSON().content?.[0]?.type).toBe('docEmbed');
  e.destroy();
});
