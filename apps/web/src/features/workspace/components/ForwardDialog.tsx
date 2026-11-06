import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { Forward, MessagesSquare } from 'lucide-react';
import type { Thread } from '@srh/shared';
import { Avatar, Button, Dialog, Textarea, toast } from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { useMessageFeed } from '@/lib/messages';
import { useForwardThread } from '../workspace-api';
import { tr, trServer } from '@/lib/i18n';

const NOTE_MAX = 2000;
const PREVIEW_COUNT = 3;

export interface ForwardDialogProps {
  projectId: string;
  thread: Thread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 预览用的一行纯文本：去掉常见 markdown 记号，压成一行。 */
function oneLine(text: string, max = 80): string {
  const s = text
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[#>*_`~|]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 转给协调者：说明会发生什么 → 选填附言 → 预览要分享的内容 → 确认。
 * 成功后时间线上出现转发卡片，会话记下 forwardedAt。
 */
export function ForwardDialog({ projectId, thread, open, onOpenChange }: ForwardDialogProps) {
  const navigate = useNavigate();
  const noteId = useId();
  const [note, setNote] = useState('');
  const forward = useForwardThread(projectId);
  const feed = useMessageFeed(projectId, thread.id);
  const shared = feed.messages.filter((m) => m.agentVisible && m.kind !== 'activity');
  const recent = shared.slice(-PREVIEW_COUNT);
  const tooLong = note.length > NOTE_MAX;

  const submit = () => {
    if (tooLong || forward.isPending) return;
    forward.mutate(
      { thread, note: note.trim() },
      {
        onSuccess: () => {
          onOpenChange(false);
          setNote('');
          toast({
            tone: 'success',
            title: tr('已转给协调者'),
            description: tr('协调者会在协作台回复你，需要时会拆成线程。'),
            action: { label: tr('去协作台'), onClick: () => navigate(projectPath(projectId, '')) },
          });
        },
        onError: (e) => toast.error(tr('没能转给协调者'), e.message),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!forward.isPending) onOpenChange(v);
      }}
      title={tr('转给协调者')}
      description={tr(
        '协调者会读到这段会话的摘要和你的附言，在协作台公开回复，并可能拆成线程。原会话仍然只有你能看到。',
      )}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={forward.isPending}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Forward strokeWidth={1.75} aria-hidden />}
            loading={forward.isPending}
            disabled={tooLong}
            onClick={submit}
          >
            {tr('转给协调者')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <label htmlFor={noteId} className="text-small font-medium text-fg">
              {tr('附言')}
              <span className="ml-1 font-normal text-fg-subtle">{tr('选填')}</span>
            </label>
            <span
              className={cn(
                'text-caption font-normal tabular-nums',
                tooLong ? 'text-danger' : 'text-fg-subtle',
              )}
              aria-live="polite"
            >
              {note.length} / {NOTE_MAX}
            </span>
          </div>
          <Textarea
            id={noteId}
            data-autofocus
            autoGrow
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={tr('比如：这个方向我想认真做，想请大家一起看看实验怎么分工')}
            error={tooLong ? tr('附言最多 {NOTE_MAX} 个字，请删减一些', { NOTE_MAX }) : undefined}
          />
        </div>

        <section aria-label={tr('将要分享的内容')}>
          <h3 className="mb-1.5 text-small font-medium text-fg">{tr('协调者会看到')}</h3>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <MessagesSquare
                size={16}
                strokeWidth={1.75}
                aria-hidden
                className="shrink-0 text-fg-subtle"
              />
              <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
                {thread.title}
              </span>
              <span className="shrink-0 text-caption font-normal text-fg-subtle tabular-nums">
                {feed.isPending ? '…' : tr('{count} 条消息', { count: shared.length })}
              </span>
            </div>
            {recent.length > 0 ? (
              <ul className="flex flex-col gap-2 px-3 py-2.5">
                {recent.map((m) => (
                  <li key={m.id} className="flex min-w-0 items-start gap-2 text-small">
                    <Avatar
                      size={20}
                      name={m.author.kind === 'agent' ? tr('个人 agent') : trServer(m.author.name)}
                      kind={m.author.kind === 'agent' ? 'agent' : 'user'}
                      className="mt-px"
                    />
                    <span className="min-w-0 flex-1 truncate text-fg-muted">{oneLine(m.body)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2.5 text-small text-fg-muted">
                {feed.isPending ? tr('正在读取会话内容') : tr('会话里还没有可以分享的消息')}
              </p>
            )}
            {shared.length > recent.length && (
              <p className="border-t border-line px-3 py-1.5 text-caption font-normal text-fg-subtle">
                {tr('以及更早的 {value} 条，协调者会读到整理后的摘要', {
                  value: shared.length - recent.length,
                })}
              </p>
            )}
          </div>
        </section>
      </form>
    </Dialog>
  );
}
