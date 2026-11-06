import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, Bot, ShieldAlert, Users } from 'lucide-react';
import type { WorkClaim } from '@srh/shared';
import { AgentThinking, Avatar, RelativeTime } from '@/components/ui';
import { ClaimBadge, ConflictBanner, type ClaimDisplay } from '@/components/collab/ClaimBadge';
import { useMotionPreset } from '@/lib/motion';
import { isAgentBusy, useAgents, useClaims, useMemberMap, useThreads } from '@/lib/project';
import {
  useActivity,
  useConflicts,
  useRealtimeStore,
  type ConflictAlert,
} from '@/lib/realtime-store';
import { projectPath } from './nav-items';
import {
  actorLabel,
  claimLabel,
  collectRefIds,
  describeActivityText,
  type PanelLookup,
} from './panel-labels';
import { usePresenceMembers } from './presence';
import { usePanelLookup } from './use-panel-lookup';
import { tr, trServer } from '@/lib/i18n';
const ACTIVITY_LIMIT = 30;
const EMPTY_CLAIMS: WorkClaim[] = [];

function PanelSection({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof Users;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="px-4 py-4">
      <h3 className="mb-3 flex items-center gap-2 text-caption text-fg-subtle">
        <Icon size={14} strokeWidth={1.75} aria-hidden />
        <span>{title}</span>
        {count !== undefined && <span className="tabular-nums">· {count}</span>}
      </h3>
      {children}
    </section>
  );
}

function PanelHint({ children }: { children: ReactNode }) {
  return <p className="py-1 text-small text-fg-subtle">{children}</p>;
}

function AgentsSection({ projectId }: { projectId: string }) {
  const agents = useAgents(projectId);
  const threads = useThreads(projectId, { kind: 'project' });
  const memberMap = useMemberMap(projectId);
  const busy = (agents.data ?? []).filter(isAgentBusy);
  const titleOf = (threadId: string | null) =>
    threadId ? threads.data?.find((t) => t.id === threadId)?.title : undefined;

  return (
    <PanelSection icon={Bot} title={tr('正在工作的 agent')} count={busy.length}>
      {busy.length === 0 ? (
        <PanelHint>{tr('当前没有运行中的 agent。')}</PanelHint>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {busy.slice(0, 6).map((a, i) => {
            const forUser = a.workingForUserId
              ? memberMap.get(a.workingForUserId)?.user.name
              : undefined;
            const title =
              a.role === 'coordinator' ? tr('协调者') : (titleOf(a.threadId) ?? tr('线程 agent'));
            const href =
              a.role === 'coordinator'
                ? projectPath(projectId, '')
                : a.threadId
                  ? projectPath(projectId, `threads/${a.threadId}`)
                  : null;
            const body = (
              <span className="flex items-start gap-2.5">
                <Avatar
                  kind={a.role === 'coordinator' ? 'coordinator' : 'agent'}
                  name={title}
                  size={24}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-fg">
                    {title}
                    {forUser && (
                      <span className="text-fg-subtle">{tr(' · 为 {forUser}', { forUser })}</span>
                    )}
                  </span>
                  {/* 同屏循环动画不超过 3 个：只给前两个 agent 扫光 */}
                  {i < 2 ? (
                    <AgentThinking label={a.activity ?? tr('思考中')} className="max-w-full" />
                  ) : (
                    <span className="block truncate text-small text-fg-muted">
                      {a.activity ?? tr('思考中')}
                    </span>
                  )}
                </span>
              </span>
            );
            return (
              <li key={a.id}>
                {href ? (
                  <Link to={href} className="block rounded-md p-1 -m-1 hover:bg-subtle">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PanelSection>
  );
}

function ClaimsSection({
  projectId,
  claims: list,
  conflicts,
  lookup,
}: {
  projectId: string;
  claims: WorkClaim[];
  conflicts: ConflictAlert[];
  lookup: PanelLookup;
}) {
  const dismiss = useRealtimeStore((s) => s.dismissConflict);
  const navigate = useNavigate();
  const describe = (c: WorkClaim): ClaimDisplay => {
    const target = claimLabel(c, lookup);
    return {
      holder: actorLabel(c.holder, lookup, c.threadId).name,
      target: target.label,
      href: target.href,
    };
  };

  return (
    <PanelSection
      icon={ShieldAlert}
      title={tr('认领与冲突预警')}
      count={list.length + conflicts.length}
    >
      <div className="flex flex-col gap-2">
        {conflicts.map((c) => (
          <ConflictBanner
            key={c.id}
            claim={c.claim}
            conflictsWith={c.conflictsWith}
            describe={describe}
            onDismiss={() => dismiss(projectId, c.id)}
            onCoordinate={() => {
              const draft = tr('请协调一下：{holder} 和 {value} 都在改 {target}，看怎么分工。', {
                holder: describe(c.claim).holder,
                value: c.conflictsWith.map((x) => describe(x).holder).join(tr('、')),
                target: describe(c.claim).target,
              });
              dismiss(projectId, c.id);
              navigate(`${projectPath(projectId, '')}?draft=${encodeURIComponent(draft)}`);
            }}
          />
        ))}
        {list.map((c) => (
          <ClaimBadge
            key={c.id}
            claim={c}
            describe={describe}
            onBehalfOf={c.onBehalfOfUserId ? lookup.memberName(c.onBehalfOfUserId) : undefined}
          />
        ))}
        {list.length === 0 && conflicts.length === 0 && (
          <PanelHint>{tr('暂无认领与冲突。')}</PanelHint>
        )}
      </div>
    </PanelSection>
  );
}

export function RightPanelActivity({ projectId }: { projectId: string }) {
  const online = usePresenceMembers(projectId);
  const activity = useActivity(projectId);
  const claims = useClaims(projectId);
  const conflicts = useConflicts(projectId);
  const { variants } = useMotionPreset();
  const claimList = claims.data ?? EMPTY_CLAIMS;

  // 面板里出现的 doc_… / exp_… 才去取标题
  const refs = useMemo(() => {
    const texts: string[] = [];
    for (const c of claimList) texts.push(c.resourceRef);
    for (const a of conflicts) {
      texts.push(a.claim.resourceRef);
      for (const c of a.conflictsWith) texts.push(c.resourceRef);
    }
    for (const e of activity.slice(0, ACTIVITY_LIMIT)) texts.push(e.text);
    return collectRefIds(texts);
  }, [claimList, conflicts, activity]);
  const lookup = usePanelLookup(projectId, refs);
  const knownClaims = useMemo(
    () => [...claimList, ...conflicts.flatMap((a) => [a.claim, ...a.conflictsWith])],
    [claimList, conflicts],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        <PanelSection icon={Users} title={tr('在线成员')} count={online.length}>
          {online.length === 0 ? (
            <PanelHint>{tr('暂无其他在线成员。')}</PanelHint>
          ) : (
            <ul className="flex flex-col gap-1">
              {online.map((m) => (
                <li key={m.id} className="flex items-center gap-2.5 rounded-md py-1">
                  <span className="relative">
                    <Avatar name={m.name} color={m.color} size={24} />
                    <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-success ring-2 ring-surface" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-fg">{m.name}</span>
                    {m.activity && (
                      <span className="block truncate text-caption font-normal text-fg-muted">
                        {m.activity}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
        <AgentsSection projectId={projectId} />
        <ClaimsSection
          projectId={projectId}
          claims={claimList}
          conflicts={conflicts}
          lookup={lookup}
        />
        <PanelSection icon={Activity} title={tr('最近活动')}>
          {activity.length === 0 ? (
            <PanelHint>{tr('暂无项目动态。')}</PanelHint>
          ) : (
            <ul className="flex flex-col gap-0.5">
              <AnimatePresence initial={false}>
                {activity.slice(0, ACTIVITY_LIMIT).map((e) => {
                  const actor = actorLabel(e.actor, lookup, e.threadId);
                  const { label: text, href } = describeActivityText(e, knownClaims, lookup);
                  const line = (
                    <span className="flex items-start gap-2.5">
                      <Avatar
                        name={trServer(actor.name)}
                        kind={actor.kind}
                        color={actor.color}
                        size={20}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1 text-small break-words text-fg-muted">
                        <span className="font-medium text-fg">{trServer(actor.name)}</span> {text}
                        <RelativeTime
                          iso={e.createdAt}
                          className="ml-1.5 text-caption font-normal text-fg-subtle"
                        />
                      </span>
                    </span>
                  );
                  return (
                    <motion.li
                      key={e.seq}
                      layout="position"
                      variants={variants.fadeUp}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      {href ? (
                        <Link
                          to={href}
                          className="block rounded-md px-1.5 py-1.5 -mx-1.5 hover:bg-subtle"
                        >
                          {line}
                        </Link>
                      ) : (
                        <div className="py-1.5">{line}</div>
                      )}
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </PanelSection>
      </div>
    </div>
  );
}
