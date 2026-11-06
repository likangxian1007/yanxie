import { motion } from 'motion/react';
import { AgentThinking, Avatar, Markdown } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { tr } from '@/lib/i18n';

export interface StreamingMessageProps {
  name: string;
  kind: 'agent' | 'coordinator';
  /** 已经流出来的文字；空串时显示“思考中” */
  text: string;
  activity?: string | null | undefined;
}

/** agent 正在生成的消息（STYLE §4.2-2）：文字逐段出现，末尾 2px agent 色光标闪烁。 */
export function StreamingMessage({ name, kind, text, activity }: StreamingMessageProps) {
  const { variants } = useMotionPreset();
  return (
    <motion.article
      variants={variants.messageIn}
      initial="hidden"
      animate="visible"
      aria-live="polite"
      aria-busy="true"
      aria-label={tr('{name} 正在回复', { name })}
      className="relative -mx-2 flex gap-3 rounded-lg px-2 pt-3 pb-1"
    >
      <div className="w-8 shrink-0">
        <Avatar name={name} kind={kind} size={32} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2">
          <span className="text-body font-semibold text-agent-text">{name}</span>
          <span className="text-caption font-normal text-fg-subtle">{tr('正在回复')}</span>
        </div>
        {text ? (
          <div className="relative">
            <Markdown>{text}</Markdown>
            <span aria-hidden className="stream-caret ml-0.5" />
          </div>
        ) : (
          <AgentThinking label={activity ?? tr('思考中')} />
        )}
      </div>
    </motion.article>
  );
}
