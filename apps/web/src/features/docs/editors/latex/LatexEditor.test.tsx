import type { ReactElement } from 'react';
import { act, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { YDOC_FIELD, type DocumentMeta } from '@srh/shared';
import type { CollabDoc } from '../../collab/useCollabDoc';
import { LatexEditor } from './LatexEditor';

function makeCollab(doc: Y.Doc) {
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', { name: '我', color: 'var(--palette-0)' });
  const provider = { setAwarenessField: vi.fn(), awareness };
  const collab = {
    doc,
    provider: provider as unknown as CollabDoc['provider'],
    status: 'connected',
    synced: true,
    me: { id: 'u1', name: '我', color: 'var(--palette-0)', colorIndex: 0, kind: 'user' },
    peers: [],
  } satisfies CollabDoc;
  return { collab, awareness };
}

const meta = { id: 'd1', title: '论文', kind: 'latex' } as unknown as DocumentMeta;

/** 编辑器里查询编译能力用到 react-query；测试环境没有服务器，能力探测失败 → 只显示草稿预览 */
function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const SOURCE = String.raw`\documentclass{article}
\title{Demo}
\begin{document}
\maketitle
\section{Intro}
Hello $x^2$.
\end{document}`;

beforeAll(() => {
  // jsdom 没有 Range 的几何 API，CodeMirror 测量时会用到
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  const rect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects ??= empty as unknown as () => DOMRectList;
  Range.prototype.getBoundingClientRect ??= rect;
});

describe('LatexEditor', () => {
  it('渲染源码与预览，上报大纲，补上远程选区颜色，并跟随远程修改', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText(YDOC_FIELD.latex);
    ytext.insert(0, SOURCE);
    const { collab, awareness } = makeCollab(doc);
    const onOutline = vi.fn();
    const { container } = render(
      <LatexEditor
        projectId="p"
        docId="d1"
        meta={meta}
        collab={collab}
        editable
        onOutline={onOutline}
      />,
    );

    expect(container.querySelector('.cm-content')?.textContent).toContain('\\section{Intro}');
    await waitFor(() => expect(container.querySelector('.ltx-title')?.textContent).toBe('Demo'));
    expect(container.querySelector('.ltx-h')?.textContent).toBe('1Intro');
    expect(onOutline).toHaveBeenCalledWith([{ heading: '1 Intro', level: 1 }]);
    const user = awareness.getLocalState()?.user as { colorLight?: string };
    expect(user.colorLight).toContain('color-mix');

    // 远程（其他成员 / agent）在 \end{document} 前追加一个小节
    act(() => {
      const at = ytext.toString().indexOf('\\end{document}');
      doc.transact(() => ytext.insert(at, '\\section{Method}\nText.\n'), 'remote');
    });
    await waitFor(() =>
      expect(onOutline).toHaveBeenLastCalledWith([
        { heading: '1 Intro', level: 1 },
        { heading: '2 Method', level: 1 },
      ]),
    );
    expect(container.querySelector('.cm-content')?.textContent).toContain('\\section{Method}');
    expect(screen.getByRole('toolbar', { name: 'LaTeX 工具栏' })).toBeInTheDocument();
  }, 20_000); // 全量并行跑时 jsdom + CodeMirror + KaTeX 首次加载较慢

  it('只读时源码不可编辑', () => {
    const doc = new Y.Doc();
    doc.getText(YDOC_FIELD.latex).insert(0, SOURCE);
    const { collab } = makeCollab(doc);
    const { container } = render(
      <LatexEditor projectId="p" docId="d1" meta={meta} collab={collab} editable={false} />,
    );
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(screen.getByText('只读')).toBeInTheDocument();
  });
});
