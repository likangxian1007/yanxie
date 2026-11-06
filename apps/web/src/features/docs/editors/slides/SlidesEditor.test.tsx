import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { DocumentMeta } from '@srh/shared';
import type { CollabDoc } from '../../collab/useCollabDoc';
import { parseSlidesMarkdown } from './lib/markdown';
import { getSlidesArray, insertSlides, replaceAllWithDrafts } from './model';
import { SlidesEditor } from './SlidesEditor';

function makeCollab(doc: Y.Doc): CollabDoc {
  return {
    doc,
    provider: { setAwarenessField: vi.fn(), awareness: null } as unknown as CollabDoc['provider'],
    status: 'connected',
    synced: true,
    me: { id: 'u1', name: '我', color: 'var(--palette-0)', colorIndex: 0, kind: 'user' },
    peers: [],
  };
}

const meta = { id: 'd2', title: '组会', kind: 'slides' } as unknown as DocumentMeta;

describe('SlidesEditor', () => {
  it('shows an empty state with the import action', () => {
    render(
      <SlidesEditor
        projectId="p"
        docId="d2"
        meta={meta}
        collab={makeCollab(new Y.Doc())}
        editable
      />,
    );
    expect(screen.getByText('还没有幻灯片')).toBeInTheDocument();
    expect(screen.getAllByText('导入 PPT').length).toBeGreaterThan(0);
  });

  it('renders thumbnails, reports the outline and follows remote inserts', async () => {
    const doc = new Y.Doc();
    replaceAllWithDrafts(
      doc,
      parseSlidesMarkdown('## 封面\n张三\n\n## 进展\n- **ViT** 复现完成'),
      null,
    );
    const onOutline = vi.fn();
    const collab = makeCollab(doc);
    render(
      <SlidesEditor
        projectId="p"
        docId="d2"
        meta={meta}
        collab={collab}
        editable
        onOutline={onOutline}
      />,
    );
    expect(screen.getByLabelText('第 1 页：封面')).toBeInTheDocument();
    expect(screen.getByLabelText('第 2 页：进展')).toBeInTheDocument();
    expect(onOutline).toHaveBeenLastCalledWith([
      { heading: '封面', level: 1 },
      { heading: '进展', level: 1 },
    ]);
    expect(collab.provider.setAwarenessField).toHaveBeenCalledWith('slide', expect.any(String));
    act(() => {
      insertSlides(
        doc,
        2,
        [{ layout: 'content', content: { title: '下期计划', body: '- 消融' } }],
        'remote',
      );
    });
    expect(await screen.findByLabelText('第 3 页：下期计划')).toBeInTheDocument();
    await waitFor(() =>
      expect(onOutline).toHaveBeenLastCalledWith([
        { heading: '封面', level: 1 },
        { heading: '进展', level: 1 },
        { heading: '下期计划', level: 1 },
      ]),
    );
  });

  it('migrates legacy layout slides when opened for editing', async () => {
    const doc = new Y.Doc();
    const m = new Y.Map<unknown>();
    m.set('id', 'old');
    m.set('layout', 'content');
    m.set('title', new Y.Text('旧页面'));
    m.set('body', new Y.Text('- 要点'));
    m.set('notes', new Y.Text('讲稿'));
    getSlidesArray(doc).push([m]);
    render(<SlidesEditor projectId="p" docId="d2" meta={meta} collab={makeCollab(doc)} editable />);
    expect(screen.getByLabelText('第 1 页：旧页面')).toBeInTheDocument();
    await waitFor(() => expect(m.get('v')).toBe(2));
    expect(m.get('order')).toBeTypeOf('string');
    expect(m.get('title')).toBeUndefined();
    expect(screen.getByLabelText('第 1 页：旧页面')).toBeInTheDocument();
  });

  it('does not migrate in read-only mode', () => {
    const doc = new Y.Doc();
    const m = new Y.Map<unknown>();
    m.set('id', 'old');
    m.set('title', new Y.Text('只读'));
    getSlidesArray(doc).push([m]);
    render(
      <SlidesEditor
        projectId="p"
        docId="d2"
        meta={meta}
        collab={makeCollab(doc)}
        editable={false}
      />,
    );
    expect(screen.getByLabelText('第 1 页：只读')).toBeInTheDocument();
    expect(m.get('v')).toBeUndefined();
  });
});
