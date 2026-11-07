import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { DocumentMeta, DocumentOutlineItem } from '@srh/shared';
import type { CollabDoc } from '../../collab/useCollabDoc';
import type { DocEditorProps } from '../types';
import type * as ApiModule from '@/lib/api';
import { mockLayoutApis } from './test-utils';
import { RichTextEditor } from './RichTextEditor';

// AI：可控的假实现（不发网络请求）
const aiState = vi.hoisted(() => ({
  status: 'idle' as 'idle' | 'streaming' | 'done' | 'error',
  text: '',
  error: null as string | null,
  calls: [] as unknown[],
}));
vi.mock('../../ai/useDocAi', async () => {
  const React = await import('react');
  return {
    readLocalOnly: () => false,
    writeLocalOnly: () => {},
    routeLabel: () => '',
    AI_ACTION_LABEL: {
      continue: '续写',
      polish: '润色',
      shorten: '精简',
      expand: '扩写',
      translate_en: '译成英文',
      translate_zh: '译成中文',
      academic: '改成学术语气',
      summarize: '总结',
      outline: '生成大纲',
      custom: '按指令写',
    },
    useDocAi: () => {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      return {
        status: aiState.status,
        text: aiState.text,
        error: aiState.error,
        run: async (input: unknown) => {
          aiState.calls.push(input);
          aiState.status = 'done';
          aiState.text = 'AI 写的**新段落**';
          force();
          return aiState.text;
        },
        stop: () => {},
        reset: () => {
          aiState.status = 'idle';
          aiState.text = '';
          aiState.error = null;
        },
      };
    },
  };
});

beforeAll(mockLayoutApis);

// 评论、成员等请求：给空数据（不发真实网络请求）
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof ApiModule>();
  const empty = async () => [];
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(empty),
      post: vi.fn(empty),
      patch: vi.fn(empty),
      delete: vi.fn(empty),
    },
  };
});

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper });
}

function fakeCollab(doc: Y.Doc, synced = true): CollabDoc {
  const provider = new HocuspocusProvider({
    url: 'ws://127.0.0.1:1',
    name: 't',
    document: doc,
    connect: false,
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  const me = {
    id: 'u1',
    name: '小明',
    color: 'var(--palette-2)',
    colorIndex: 2,
    kind: 'user' as const,
  };
  return {
    doc,
    provider,
    status: 'connected',
    synced,
    me,
    peers: [{ clientId: doc.clientID, user: me, state: {}, isSelf: true }],
  };
}

function seed(doc: Y.Doc) {
  const frag = doc.getXmlFragment('default');
  const h = new Y.XmlElement('heading');
  h.setAttribute('level', 1 as unknown as string);
  h.insert(0, [new Y.XmlText('引言')]);
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText('研究背景与动机')]);
  const h2 = new Y.XmlElement('heading');
  h2.setAttribute('level', 2 as unknown as string);
  h2.insert(0, [new Y.XmlText('方法')]);
  frag.insert(0, [h, p, h2]);
}

function props(collab: CollabDoc, extra: Partial<DocEditorProps> = {}): DocEditorProps {
  return {
    projectId: 'p1',
    docId: 'd1',
    meta: {} as DocumentMeta,
    collab,
    editable: true,
    ...extra,
  };
}

describe('RichTextEditor', () => {
  it('未同步时显示骨架', () => {
    const doc = new Y.Doc();
    render(<RichTextEditor {...props(fakeCollab(doc, false))} />);
    expect(screen.getByLabelText('正在加载文档')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '文档正文' })).toBeNull();
  });

  it('渲染 Y.Doc 内容、工具栏、状态栏，并上报大纲', async () => {
    const doc = new Y.Doc();
    seed(doc);
    const onOutline = vi.fn<(items: DocumentOutlineItem[]) => void>();
    render(<RichTextEditor {...props(fakeCollab(doc), { onOutline })} />);
    const body = await screen.findByRole('textbox', { name: '文档正文' });
    expect(body).toHaveTextContent('研究背景与动机');
    expect(screen.getByRole('toolbar', { name: '编辑工具栏' })).toBeInTheDocument();
    expect(screen.getByText('1 人正在编辑')).toBeInTheDocument();
    await waitFor(() =>
      expect(onOutline).toHaveBeenCalledWith([
        { heading: '引言', level: 1 },
        { heading: '方法', level: 2 },
      ]),
    );
    expect(screen.getByText(/字数 \d+/)).toHaveTextContent('字数 11');
  });

  it('只读时没有工具栏，正文不可编辑', async () => {
    const doc = new Y.Doc();
    seed(doc);
    render(<RichTextEditor {...props(fakeCollab(doc), { editable: false })} />);
    const body = await screen.findByRole('textbox', { name: '文档正文' });
    expect(body).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByRole('toolbar', { name: '编辑工具栏' })).toBeNull();
    expect(screen.getByText('只读')).toBeInTheDocument();
  });

  it('jumpTo 不报错（滚动到第 n 个标题）', async () => {
    const doc = new Y.Doc();
    seed(doc);
    const { rerender } = render(<RichTextEditor {...props(fakeCollab(doc))} />);
    await screen.findByRole('textbox', { name: '文档正文' });
    const collab = fakeCollab(doc);
    rerender(<RichTextEditor {...props(collab, { jumpTo: { index: 1, nonce: 1 } })} />);
    await waitFor(() =>
      expect(document.querySelector('.rich-jump-flash')).toHaveTextContent('方法'),
    );
  });

  it('工具栏 AI → 输入条 → 建议 → 预览 → 插入到下方，确认后才写进 Y.Doc', async () => {
    const doc = new Y.Doc();
    seed(doc);
    render(<RichTextEditor {...props(fakeCollab(doc))} />);
    await screen.findByRole('textbox', { name: '文档正文' });
    const frag = doc.getXmlFragment('default');
    const before = frag.toString();

    fireEvent.click(screen.getByRole('button', { name: 'AI' }));
    expect(await screen.findByLabelText('给 AI 的指令')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /续写/ }));
    });
    expect(aiState.calls).toHaveLength(1);
    const insert = await screen.findByRole('button', { name: '插入到下方' });
    // 预览阶段：Y.Doc 不变
    expect(frag.toString()).toBe(before);
    await act(async () => {
      fireEvent.click(insert);
    });
    expect(frag.toString()).toContain('新段落');
    expect(frag.toString()).toContain('<bold>');
    expect(screen.queryByRole('button', { name: '插入到下方' })).toBeNull();
  });
});
