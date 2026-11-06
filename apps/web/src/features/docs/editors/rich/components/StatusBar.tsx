import type { CollabPeer } from '../../../collab/useCollabDoc';
import { MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/cn';
import { peerColor } from '../ext/caret';
import { locale, tr } from '@/lib/i18n';

export interface StatusBarProps {
  words: number;
  /** 字符数（不含空白） */
  chars?: number;
  /** 页面视图下的总页数 */
  pages?: number | null;
  peers: CollabPeer[];
  editable: boolean;
  /** 只读时评论入口放在状态栏（可编辑时在工具栏） */
  comments?: { open: boolean; count: number; toggle: () => void };
}

const NUMBER = new Intl.NumberFormat(locale());

/** 底部状态条：页数、字数、字符数、正在编辑的人数。 */
export function StatusBar({ words, chars, pages, peers, editable, comments }: StatusBarProps) {
  const editing = Math.max(1, peers.length);
  const shown = peers.slice(0, 5);
  return (
    <div className="flex h-8 shrink-0 items-center gap-4 border-t border-line bg-canvas px-4 text-caption text-fg-subtle sm:px-6">
      {pages ? (
        <span className="tabular-nums">
          {tr('共 {NUMBER} 页', { NUMBER: NUMBER.format(pages) })}
        </span>
      ) : null}
      <span className="tabular-nums">{tr('字数 {NUMBER}', { NUMBER: NUMBER.format(words) })}</span>
      {chars !== undefined && (
        <span className="hidden tabular-nums sm:inline">
          {tr('字符 {NUMBER}', { NUMBER: NUMBER.format(chars) })}
        </span>
      )}
      <span className="flex items-center gap-1.5">
        {shown.length > 0 && (
          <span aria-hidden className="flex items-center -space-x-1">
            {shown.map((p) => (
              <span
                key={p.clientId}
                className={cn(
                  'size-2 rounded-full ring-2 ring-canvas',
                  p.user.kind === 'agent' && 'bg-agent-gradient',
                )}
                style={
                  p.user.kind === 'agent'
                    ? undefined
                    : { backgroundColor: peerColor(p.user as unknown as Record<string, unknown>) }
                }
              />
            ))}
          </span>
        )}
        <span className="tabular-nums">{tr('{editing} 人正在编辑', { editing })}</span>
      </span>
      <span className="flex-1" />
      {/* 可编辑时评论入口在工具栏；手机上工具栏要点进正文才出现，所以这里也放一个 */}
      {comments && (
        <button
          type="button"
          aria-pressed={comments.open}
          onClick={comments.toggle}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-subtle hover:text-fg',
            'max-md:-my-1 max-md:h-8 max-md:px-2.5',
            editable && 'md:hidden',
          )}
        >
          <MessageSquareText className="size-3.5" strokeWidth={1.75} aria-hidden />
          {tr('评论')}
          {comments.count > 0 ? ` ${comments.count}` : ''}
        </button>
      )}
      {!editable && <span>{tr('只读')}</span>}
    </div>
  );
}
