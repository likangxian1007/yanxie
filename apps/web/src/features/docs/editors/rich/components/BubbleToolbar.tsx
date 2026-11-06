import { useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { DocumentAiAction } from '@srh/shared';
import {
  Bold,
  ChevronDown,
  GraduationCap,
  Highlighter,
  Italic,
  Languages,
  Link,
  MessageSquarePlus,
  MessageSquareText,
  PenLine,
  Scissors,
  Sparkles,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { IconButton, Separator } from '@/components/ui';
import { cn } from '@/lib/cn';
import { aiSessionKey } from '../ext/ai-session';
import { shortcutLabel } from '../lib/text';
import { ICON_STROKE } from './icons';
import { LinkForm } from './LinkForm';
import { tr } from '@/lib/i18n';

interface AiItem {
  action: DocumentAiAction | 'prompt';
  label: string;
  icon: LucideIcon;
}

const AI_ITEMS: AiItem[] = [
  { action: 'polish', label: tr('润色'), icon: WandSparkles },
  { action: 'shorten', label: tr('精简'), icon: Scissors },
  { action: 'expand', label: tr('扩写'), icon: PenLine },
  { action: 'academic', label: tr('改成学术语气'), icon: GraduationCap },
  { action: 'translate_en', label: tr('译成英文'), icon: Languages },
  { action: 'translate_zh', label: tr('译成中文'), icon: Languages },
  { action: 'prompt', label: tr('自定义指令…'), icon: MessageSquareText },
];

export interface BubbleToolbarProps {
  editor: Editor;
  /** 对选区执行 AI 动作；不传 action = 打开输入条 */
  onAi: (action?: DocumentAiAction) => void;
  /** 对选区发起评论 */
  onComment?: () => void;
  /** 只读但可评论：选区只弹「评论」 */
  commentOnly?: boolean;
}

/** 选区气泡菜单：加粗 / 斜体 / 链接 / 高亮 + AI 下拉。 */
export function BubbleToolbar({ editor, onAi, onComment, commentOnly }: BubbleToolbarProps) {
  const [mode, setMode] = useState<'tools' | 'link'>('tools');
  const [aiOpen, setAiOpen] = useState(false);
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      highlight: e.isActive('highlight'),
      link: e.isActive('link'),
    }),
  });

  const reset = () => {
    setMode('tools');
    setAiOpen(false);
  };

  return (
    <BubbleMenu
      editor={editor}
      className="z-popover"
      shouldShow={({ editor: e, state, view, element }) => {
        if (!e.isEditable && !commentOnly) return false;
        if (aiSessionKey.getState(state)?.open) return false;
        const { selection } = state;
        if (selection.empty || selection instanceof NodeSelection) return false;
        if (e.isActive('codeBlock')) return false;
        if (!state.doc.textBetween(selection.from, selection.to, ' ').trim()) return false;
        // 选中表格单元格（CellSelection）时不弹
        if ('$anchorCell' in selection) return false;
        // 只读编辑器拿不到焦点：有选区就弹
        if (commentOnly) return true;
        return view.hasFocus() || element.contains(document.activeElement);
      }}
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 }, onHide: reset }}
    >
      <div
        role="toolbar"
        aria-label={tr('文字格式')}
        className="relative flex items-center gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-lg"
      >
        {commentOnly ? null : mode === 'link' ? (
          <LinkForm editor={editor} compact onDone={reset} />
        ) : (
          <>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={aiOpen}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAiOpen((v) => !v)}
              className={cn(
                'press inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm px-2 text-small font-medium text-agent-text',
                'hover:bg-agent-soft aria-expanded:bg-agent-soft',
              )}
            >
              <Sparkles className="size-4" strokeWidth={ICON_STROKE} aria-hidden />
              AI
              <ChevronDown className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden />
            </button>
            <Separator orientation="vertical" className="mx-0.5 my-1" />
            <BubbleButton
              label={tr('加粗')}
              shortcut="Mod-b"
              active={active.bold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold strokeWidth={ICON_STROKE} />
            </BubbleButton>
            <BubbleButton
              label={tr('斜体')}
              shortcut="Mod-i"
              active={active.italic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic strokeWidth={ICON_STROKE} />
            </BubbleButton>
            <BubbleButton label={tr('链接')} active={active.link} onClick={() => setMode('link')}>
              <Link strokeWidth={ICON_STROKE} />
            </BubbleButton>
            <BubbleButton
              label={tr('高亮')}
              shortcut="Mod-Shift-h"
              active={active.highlight}
              onClick={() => editor.chain().focus().toggleHighlight().run()}
            >
              <Highlighter strokeWidth={ICON_STROKE} />
            </BubbleButton>
          </>
        )}
        {onComment && (mode === 'tools' || commentOnly) && (
          <>
            {!commentOnly && <Separator orientation="vertical" className="mx-0.5 my-1" />}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                reset();
                onComment();
              }}
              title={tr('评论（{value}）', { value: shortcutLabel('Mod-Alt-m') })}
              className="press inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm px-2 text-small font-medium text-fg-muted hover:bg-subtle hover:text-fg"
            >
              <MessageSquarePlus className="size-4" strokeWidth={ICON_STROKE} aria-hidden />
              {tr('评论')}
            </button>
          </>
        )}
        {aiOpen && mode === 'tools' && (
          <div
            role="menu"
            aria-label={tr('AI 改写')}
            className="absolute top-full left-0 mt-1.5 flex w-48 origin-top-left flex-col rounded-lg border border-line bg-elevated p-1 shadow-lg"
          >
            {AI_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    reset();
                    onAi(item.action === 'prompt' ? undefined : item.action);
                  }}
                  className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-body text-fg hover:bg-subtle focus-visible:bg-subtle"
                >
                  <Icon className="size-4 text-agent" strokeWidth={ICON_STROKE} aria-hidden />
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </BubbleMenu>
  );
}

function BubbleButton({
  label,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      size="sm"
      label={label}
      tooltipSide="top"
      {...(shortcut ? { shortcut: shortcutLabel(shortcut) } : {})}
      aria-pressed={active}
      className={cn(active && 'bg-accent-soft text-accent-text hover:bg-accent-soft')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}
