import { useMemo, useState } from 'react';
import { Bot, CornerDownRight } from 'lucide-react';
import type { DocumentOutlineItem } from '@srh/shared';
import { ClaimBadge } from '@/components/collab/ClaimBadge';
import { Button } from '@/components/ui';
import { useClaims, useMemberMap } from '@/lib/project';
import type { CollabPeer } from '../collab/useCollabDoc';
import { toDocClaimViews } from './claimViews';
import { tr } from '@/lib/i18n';

const MAX_SHOWN = 3;

/**
 * 文档页顶部的认领条（ARCHITECTURE §5.3-6）：谁（或谁的 agent）正在改这篇文档的哪一节。
 * 人在编辑器里照常可以改（Yjs 会合并），这里只是提示，避免两边改同一节。
 * agent 正在写入时（awareness 里出现 agent）也在这里显示一行。
 */
export function DocClaims({
  pid,
  docId,
  title,
  outline,
  peers,
  onJump,
}: {
  pid: string;
  docId: string;
  title: string;
  outline: DocumentOutlineItem[];
  peers: CollabPeer[];
  onJump: (outlineIndex: number) => void;
}) {
  const claims = useClaims(pid);
  const members = useMemberMap(pid);
  const [expanded, setExpanded] = useState(false);
  const views = useMemo(
    () =>
      toDocClaimViews(claims.data ?? [], docId, title, outline, (id) => members.get(id)?.user.name),
    [claims.data, docId, title, outline, members],
  );
  const writingAgents = peers.filter((p) => !p.isSelf && p.user.kind === 'agent');

  if (views.length === 0 && writingAgents.length === 0) return null;
  const shown = expanded ? views : views.slice(0, MAX_SHOWN);

  return (
    <section
      aria-label={tr('认领与正在编辑')}
      className="mx-4 mb-2 flex flex-col gap-1.5 md:mx-6"
      aria-live="polite"
    >
      {writingAgents.map((p) => (
        <p
          key={`agent-${p.clientId}`}
          className="flex items-center gap-1.5 rounded-md bg-agent-soft px-2.5 py-1.5 text-small text-agent-text"
        >
          <Bot size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate">
            <span className="font-medium">{p.user.name}</span>
            {tr(' 正在编辑这篇文档')}
          </span>
        </p>
      ))}
      {shown.map((v) => (
        <div key={v.claim.id} className="flex items-start gap-1">
          <ClaimBadge claim={v.display} className="min-w-0 flex-1" />
          {v.outlineIndex >= 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-0.5 shrink-0"
              leftIcon={<CornerDownRight size={14} strokeWidth={1.75} aria-hidden />}
              onClick={() => onJump(v.outlineIndex)}
            >
              <span className="hidden sm:inline">{tr('跳到这一节')}</span>
              <span className="sr-only sm:hidden">{tr('跳到这一节')}</span>
            </Button>
          )}
        </div>
      ))}
      {views.length > MAX_SHOWN && (
        <button
          type="button"
          className="self-start rounded-sm px-1 text-caption text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? tr('收起') : tr('还有 {value} 条认领', { value: views.length - MAX_SHOWN })}
        </button>
      )}
    </section>
  );
}
