import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, Dialog, Textarea } from '@/components/ui';
import { tr } from '@/lib/i18n';

export type AiPromptMode = 'custom' | 'section';

interface AiPromptDialogProps {
  mode: AiPromptMode | null;
  /** 按指令改：选中了多少行 */
  selectionLines: number;
  onClose: () => void;
  onSubmit: (mode: AiPromptMode, prompt: string) => void;
}

const COPY: Record<
  AiPromptMode,
  { title: string; description: string; placeholder: string; cta: string }
> = {
  custom: {
    title: tr('按指令修改选区'),
    description: tr('AI 只改写选中的这段 LaTeX，保留命令和公式。结果先给你预览，确认后才写入。'),
    placeholder: tr('例如：把这段改成更正式的学术语气，并补一句和相关工作的对比'),
    cta: tr('开始修改'),
  },
  section: {
    title: tr('AI 写一个小节'),
    description: tr('写出完整的 \\section 小节（可含公式、列表），预览满意后插入到光标处。'),
    placeholder: tr('小节主题，例如：实验设置——数据集、评价指标和实现细节'),
    cta: tr('开始写'),
  },
};

export function AiPromptDialog({ mode, selectionLines, onClose, onSubmit }: AiPromptDialogProps) {
  const [text, setText] = useState('');
  const copy = mode ? COPY[mode] : COPY.custom;
  const submit = () => {
    const value = text.trim();
    if (!mode || !value) return;
    onSubmit(mode, value);
    setText('');
  };

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={copy.title}
      description={
        mode === 'custom' && selectionLines > 0
          ? tr('{description}（已选 {selectionLines} 行）', {
              description: copy.description,
              selectionLines,
            })
          : copy.description
      }
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Sparkles strokeWidth={1.75} aria-hidden />}
            disabled={!text.trim()}
            onClick={submit}
          >
            {copy.cta}
          </Button>
        </>
      }
    >
      <Textarea
        data-autofocus
        autoGrow
        rows={3}
        maxLength={2000}
        value={text}
        aria-label={copy.title}
        placeholder={copy.placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <p className="mt-2 text-caption text-fg-subtle">{tr('按 Ctrl / ⌘ + Enter 提交')}</p>
    </Dialog>
  );
}
