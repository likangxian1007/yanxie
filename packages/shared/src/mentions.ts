import { z } from 'zod';
/** 聊天正文的 UTF-16 范围，与 textarea.selectionStart 一致，end 不包含末尾字符。 */
export const MessageMention = z.object({
  userId: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  label: z.string().min(1).max(200),
});
export type MessageMention = z.infer<typeof MessageMention>;
export const MessageMentions = z.array(MessageMention).max(100);
