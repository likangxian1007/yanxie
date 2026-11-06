import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import type { ProjectMember } from '@srh/shared';
import { api } from '@/lib/api';
import { useMembers } from '@/lib/project';
import { dismissMention, mentionKey, type MentionBridge } from '../ext/mention-suggest';
import { FloatingPanel } from './FloatingPanel';
import { coordsAt } from './anchor';
import { MemberOptions, filterMembers } from './MemberOptions';
import { tr } from '@/lib/i18n';

export interface MentionMenuProps {
  editor: Editor;
  bridge: MentionBridge;
  projectId: string;
  docId: string;
}

interface MentionView {
  from: number;
  to: number;
  query: string;
}

/** 在正文 pos 处插入 @成员，并通知对方（“待我处理”里会出现一条提醒） */
export function insertMention(
  editor: Editor,
  range: { from: number; to: number },
  member: Pick<ProjectMember['user'], 'id' | 'name'>,
  notify: { projectId: string; docId: string },
) {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: 'mention', attrs: { id: member.id, label: member.name } },
      { type: 'text', text: ' ' },
    ])
    .run();
  const $pos = editor.state.doc.resolve(Math.min(range.from, editor.state.doc.content.size));
  const context = $pos.parent.textContent.slice(0, 120);
  void api
    .post(`/projects/${notify.projectId}/docs/${notify.docId}/mentions`, {
      userIds: [member.id],
      context,
    })
    .catch(() => {
      // 提醒没发出去不影响正文
    });
}

/** 正文 “@” 成员菜单 */
export function MentionMenu({ editor, bridge, projectId, docId }: MentionMenuProps) {
  const view = useEditorState({
    editor,
    selector: ({ editor: e }): MentionView | null => {
      const s = mentionKey.getState(e.state);
      return s?.active ? { from: s.from, to: s.to, query: s.query } : null;
    },
  });
  if (!view) return null;
  return (
    <MentionList
      key={view.query}
      editor={editor}
      bridge={bridge}
      projectId={projectId}
      docId={docId}
      view={view}
    />
  );
}

function MentionList({
  editor,
  bridge,
  projectId,
  docId,
  view,
}: MentionMenuProps & { view: MentionView }) {
  const members = useMembers(projectId);
  const items = useMemo(
    () => filterMembers(members.data ?? [], view.query),
    [members.data, view.query],
  );
  const [index, setIndex] = useState(0);
  const pick = (m: ProjectMember) =>
    insertMention(editor, { from: view.from, to: view.to }, m.user, { projectId, docId });
  const latest = useRef({ items, index, pick });
  useEffect(() => {
    latest.current = { items, index, pick };
  });

  useEffect(() => {
    bridge.onKeyDown.set((event) => {
      const { items: list, index: i, pick: run } = latest.current;
      if (event.key === 'Escape') {
        editor.view.dispatch(dismissMention(editor.state));
        return true;
      }
      if (list.length === 0) return false;
      if (event.key === 'ArrowDown') {
        setIndex((i + 1) % list.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setIndex((i - 1 + list.length) % list.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const m = list[i];
        if (m) run(m);
        return true;
      }
      return false;
    });
    return () => bridge.onKeyDown.set(null);
  }, [bridge, editor]);

  return (
    <FloatingPanel
      anchor={coordsAt(editor.view, view.from)}
      role="listbox"
      label={tr('提及成员')}
      className="w-60"
      onDismiss={() => editor.view.dispatch(dismissMention(editor.state))}
    >
      <div className="px-2 pt-1.5 pb-1 text-caption text-fg-subtle">
        {tr('提及成员，对方会收到提醒')}
      </div>
      <MemberOptions
        items={items}
        index={index}
        onHover={setIndex}
        onPick={pick}
        empty={members.isPending ? tr('正在加载成员…') : tr('没有找到这个成员')}
      />
    </FloatingPanel>
  );
}
