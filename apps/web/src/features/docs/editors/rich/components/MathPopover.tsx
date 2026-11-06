import { useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import type { Editor } from '@tiptap/core';
import { Button, Kbd, Textarea } from '@/components/ui';
import { shortcutLabel } from '../lib/text';
import { FloatingPanel } from './FloatingPanel';
import type { AnchorRect } from './anchor';
import { tr } from '@/lib/i18n';

/** 公式编辑目标：插入新公式，或编辑已有公式节点（pos 为节点位置）。 */
export interface MathTarget {
  mode: 'insert' | 'edit';
  kind: 'inline' | 'block';
  pos: number | null;
  latex: string;
  anchor: AnchorRect;
}

export interface MathPopoverProps {
  editor: Editor;
  target: MathTarget;
  onClose: () => void;
}

function renderPreview(latex: string, block: boolean): { html: string; error: string | null } {
  if (!latex.trim()) return { html: '', error: null };
  try {
    return {
      html: katex.renderToString(latex, { displayMode: block, throwOnError: true, strict: false }),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/, '') : '';
    return { html: '', error: message || tr('公式写法有误') };
  }
}

/** 点击公式 / 插入公式时的小浮层：输入 LaTeX，实时预览，Mod+Enter 确定，Esc 取消。 */
export function MathPopover({ editor, target, onClose }: MathPopoverProps) {
  const [latex, setLatex] = useState(target.latex);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const block = target.kind === 'block';

  // 从工具栏菜单打开时，菜单关闭会把焦点还给触发按钮；晚一拍再聚焦输入框
  useEffect(() => {
    const t = window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  const preview = useMemo(() => renderPreview(latex, block), [latex, block]);

  const commit = () => {
    const value = latex.trim();
    const chain = editor.chain().focus();
    if (target.mode === 'insert') {
      if (!value) return onClose();
      if (block) chain.insertBlockMath({ latex: value }).run();
      else chain.insertInlineMath({ latex: value }).run();
    } else if (target.pos !== null) {
      const pos = target.pos;
      if (!value) {
        if (block) chain.deleteBlockMath({ pos }).run();
        else chain.deleteInlineMath({ pos }).run();
      } else if (block) {
        chain.updateBlockMath({ latex: value, pos }).run();
      } else {
        chain.updateInlineMath({ latex: value, pos }).run();
      }
    }
    onClose();
  };

  const remove = () => {
    if (target.pos === null) return onClose();
    const chain = editor.chain().focus();
    if (block) chain.deleteBlockMath({ pos: target.pos }).run();
    else chain.deleteInlineMath({ pos: target.pos }).run();
    onClose();
  };

  const cancel = () => {
    onClose();
    editor.commands.focus();
  };

  return (
    <FloatingPanel
      anchor={target.anchor}
      label={block ? tr('编辑公式块') : tr('编辑行内公式')}
      className="w-80 p-3"
      onDismiss={onClose}
      onEscape={cancel}
    >
      <div className="flex flex-col gap-2">
        <div className="text-caption text-fg-subtle">
          {block ? tr('公式块') : tr('行内公式')} · LaTeX
        </div>
        <Textarea
          ref={inputRef}
          rows={block ? 3 : 2}
          value={latex}
          spellCheck={false}
          placeholder={block ? '\\sum_{i=1}^{n} x_i' : 'E = mc^2'}
          aria-label={tr('LaTeX 公式')}
          className="font-mono text-small"
          onChange={(e) => setLatex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!block && !e.shiftKey))) {
              if (e.nativeEvent.isComposing) return;
              e.preventDefault();
              commit();
            }
          }}
        />
        <div
          className="min-h-10 overflow-x-auto rounded-md bg-subtle px-3 py-2 text-fg"
          aria-live="polite"
        >
          {preview.error ? (
            <span className="text-caption font-normal text-danger">
              {tr('公式有误：{error}', { error: preview.error })}
            </span>
          ) : preview.html ? (
            <span dangerouslySetInnerHTML={{ __html: preview.html }} />
          ) : (
            <span className="text-caption font-normal text-fg-subtle">
              {tr('在上面输入 LaTeX，这里实时预览')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-caption text-fg-subtle">
            <Kbd>{block ? shortcutLabel('Mod-Enter') : 'Enter'}</Kbd>
            {tr(' 确定')}
          </span>
          <span className="flex-1" />
          {target.mode === 'edit' && (
            <Button size="sm" variant="ghost" onClick={remove}>
              {tr('删除')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={cancel}>
            {tr('取消')}
          </Button>
          <Button size="sm" variant="primary" onClick={commit}>
            {target.mode === 'insert' ? tr('插入') : tr('确定')}
          </Button>
        </div>
      </div>
    </FloatingPanel>
  );
}
