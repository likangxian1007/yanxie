import { api } from '@/lib/api';
import { discussionParams } from '@/features/discussion/links';
import { discussionKey, useDiscussionReading } from '@/features/discussion/reading-store';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ArrowDown, CloudOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { Message, Thread, User } from '@srh/shared';
import { Button, Skeleton } from '@/components/ui';
import { useLocation, useNavigate } from 'react-router';
import { flashElement } from '@/lib/message-link';
import { useMessageFeed } from '@/lib/messages';
import { useMotionPreset } from '@/lib/motion';
import { useAgents } from '@/lib/project';
import { useDraftsFor } from '@/lib/realtime-store';
import { MessageItem } from './MessageItem';
import { StreamingMessage } from './StreamingMessage';
import { locale, tr } from '@/lib/i18n';

export interface MessageFeedProps {
  projectId: string;
  channel?: 'all' | 'agent' | 'team';
  scrollRef?: RefObject<HTMLDivElement | null>;
  scrollScope?: string;
  onQuote?: ((message: Message) => void) | undefined;
  /** null = 协作台时间线 */
  threadId: string | null;
  me: User | null;
  readOnly?: boolean;
  /** 时间线：rootOfThreadId → 线程，用来在消息下挂线程卡片 */
  threadsById?: Map<string, Thread>;
  threadHref?: (thread: Thread) => string;
  /** 没有消息时显示 */
  empty?: ReactNode;
  /** 过滤（例如线程页把根消息单独展示） */
  filter?: (m: Message) => boolean;
}

const GROUP_MS = 5 * 60_000;
/** 定位 #msg_… 时最多往前翻几页 */
const MAX_SEEK_PAGES = 20;
const scrollPositions = new Map<string, number>();

function sameDay(a: string, b: string) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return tr('今天');
  if (d.toDateString() === y.toDateString()) return tr('昨天');
  return d.toLocaleDateString(locale(), { month: 'long', day: 'numeric', weekday: 'short' });
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-6 py-4" aria-label={tr('加载中')}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 w-full max-w-lg" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 滚动容器：AppShell 的 #app-scroll */
function scroller(): HTMLElement | null {
  return document.getElementById('app-scroll');
}

function setScrollTop(el: HTMLElement, top: number) {
  el.scrollTop = top;
}

function nearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
}

/**
 * 消息流（时间线 / 线程共用）：旧→新排列，按天分隔，同一作者 5 分钟内的消息合并头像；
 * 底部是 agent 正在流式生成的消息。新消息到来时若人在底部附近就跟随滚动，否则显示“有新消息”。
 */
export function MessageFeed({
  projectId,
  threadId,
  me,
  readOnly,
  threadsById,
  threadHref,
  empty,
  filter,
  channel = 'agent',
  scrollRef,
  scrollScope,
  onQuote,
}: MessageFeedProps) {
  const feed = useMessageFeed(projectId, threadId, channel);
  const allDrafts = useDraftsFor(threadId);
  const drafts = channel === 'team' ? [] : allDrafts;
  const agents = useAgents(projectId);
  const { variants, reduced: reducedMotion } = useMotionPreset();
  const messages = useMemo(
    () => (filter ? feed.messages.filter(filter) : feed.messages),
    [feed.messages, filter],
  );
  const readKey = discussionKey(me?.id, projectId, threadId);
  const latestId = messages.at(-1)?.id;
  const latestRef = useRef(latestId);
  useEffect(() => {
    latestRef.current = latestId;
  }, [latestId]);
  // 挂载之后才到达的消息才做入场动画（首屏不整页飞入）
  const [mountedAt] = useState(() => Date.now() - 1500);
  const [unseen, setUnseen] = useState(0);
  const previousMessages = useRef<Message[] | null>(null);
  const firstScroll = useRef(false);
  /** 人是否停在底部附近（由滚动事件更新） */
  const stick = useRef(true);
  const draftText = drafts.map((d) => d.text.length).join(',');

  // 地址里带 #msg_…（站内引用跳过来）：定位到那条消息并闪一下
  const location = useLocation();
  const { hash } = location;
  const navigate = useNavigate();
  const scrollKey = `${readKey}:${channel}:${scrollScope ?? (scrollRef ? 'panel' : 'page')}`;
  const [seekLimit, setSeekLimit] = useState(MAX_SEEK_PAGES);
  const [resolvedTarget, setResolvedTarget] = useState('');
  const seeking = channel === 'agent' && hash.startsWith('#msg_') && resolvedTarget !== hash;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (channel !== 'agent' || !hash.startsWith('#msg_')) return;
    const controller = new AbortController();
    api
      .get<Message>(`/projects/${projectId}/messages/${encodeURIComponent(hash.slice(1))}`, {
        signal: controller.signal,
      })
      .then((message) => {
        if (controller.signal.aborted) return;
        if (!message.agentVisible)
          navigate(
            {
              pathname: location.pathname,
              search: `?${discussionParams(location.search, message.threadId ?? 'project')}`,
              hash,
            },
            { replace: true },
          );
        else setResolvedTarget(hash);
      })
      .catch(() => {
        if (!controller.signal.aborted) setResolvedTarget(hash);
      });
    return () => controller.abort();
  }, [channel, hash, projectId, navigate, location.pathname, location.search]);
  const targetId = hash.startsWith('#msg_') ? decodeURIComponent(hash.slice(1)) : null;
  /** 已经处理过的 hash（找到了，或翻完了也没找到） */
  const handledTarget = useRef<string | null>(null);
  const olderPagesForTarget = useRef(0);
  useEffect(() => {
    olderPagesForTarget.current = 0;
    handledTarget.current = null;
  }, [targetId]);

  // 首次加载：滚到底（要定位消息时交给下面的 effect）
  useLayoutEffect(() => {
    if (firstScroll.current || !feed.isSuccess) return;
    firstScroll.current = true;
    const el = scrollRef?.current ?? scroller();
    if (targetId) stick.current = false;
    else if (el) {
      setScrollTop(el, scrollPositions.get(scrollKey) ?? el.scrollHeight);
      stick.current = nearBottom(el);
    }
  }, [feed.isSuccess, targetId, scrollRef, scrollKey]);

  // 目标消息不在已加载的几页里：往前翻页直到找到（最多 MAX_SEEK_PAGES 页）
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    if (
      !targetId ||
      seeking ||
      (channel === 'agent' && location.search.includes('discussion=')) ||
      !feed.isSuccess ||
      handledTarget.current === targetId
    )
      return;
    const el = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(
      (node) => node.id === targetId,
    );
    if (el) {
      handledTarget.current = targetId;
      stick.current = false;
      flashElement(el, reducedMotion);
      return;
    }
    if (!hasNextPage) {
      handledTarget.current = targetId;
      return;
    }
    if (isFetchingNextPage || olderPagesForTarget.current >= seekLimit) return;
    olderPagesForTarget.current += 1;
    void fetchNextPage();
  }, [
    targetId,
    feed.isSuccess,
    messages,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    reducedMotion,
    seeking,
    channel,
    location.search,
    seekLimit,
  ]);

  // 新消息 / 流式文字：在底部附近就跟随
  useEffect(() => {
    const el = scrollRef?.current ?? scroller();
    if (!el || !firstScroll.current) return;
    const latest = messages.at(-1)?.id;
    const previous = previousMessages.current;
    const previousIds = new Set(previous?.map((message) => message.id));
    const previousTime = previous?.at(-1)?.createdAt;
    const lastKnownIndex = messages.findLastIndex((message) => previousIds.has(message.id));
    const candidates = lastKnownIndex >= 0 ? messages.slice(lastKnownIndex + 1) : messages;
    const added = previous
      ? candidates.filter((message) => {
          if (previousIds.has(message.id)) return false;
          if (previousTime && message.createdAt < previousTime) return false;
          return !previous.some(
            (old) =>
              old.id.startsWith('tmp_') &&
              old.author.id === message.author.id &&
              old.body === message.body &&
              old.agentVisible === message.agentVisible,
          );
        }).length
      : 0;
    previousMessages.current = messages;
    if (stick.current) {
      // 直接跳到底（流式输出时平滑滚动会追不上）
      setScrollTop(el, el.scrollHeight);
      stick.current = true;
      if (channel === 'team' && latest) useDiscussionReading.getState().read(readKey, latest);
    } else if (added > 0) {
      queueMicrotask(() => setUnseen((n) => n + added));
    }
  }, [messages, draftText, scrollRef, channel, readKey]);

  useEffect(() => {
    const el = scrollRef?.current ?? scroller();
    if (!el) return;
    const onScroll = () => {
      stick.current = nearBottom(el);
      if (stick.current) {
        setUnseen(0);
        if (channel === 'team' && latestRef.current)
          useDiscussionReading.getState().read(readKey, latestRef.current);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scrollPositions.delete(scrollKey);
      scrollPositions.set(scrollKey, el.scrollTop);
      if (scrollPositions.size > 100) scrollPositions.delete(scrollPositions.keys().next().value!);
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, channel, readKey, scrollKey]);

  // 布局晚到（Markdown/公式/图片渲染、入场动画、流式草稿换成正式消息、输入框自动增高、
  // 手机键盘或安全区变化）时，人若停在底部就继续贴住真正的底部，避免最后一行被吸底输入框挡住
  const feedReady = feed.isSuccess;
  useEffect(() => {
    const el = scrollRef?.current ?? scroller();
    const root = rootRef.current;
    if (!el || !root || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const pin = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 定位 #msg_… 时 stick 已为 false，不会把人拽回底部
        if (firstScroll.current && stick.current) setScrollTop(el, el.scrollHeight);
      });
    };
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    observer.observe(root);
    for (const child of Array.from(el.children)) observer.observe(child);
    // 图片（附件缩略图、Markdown 里的图）加载完或失败换成小标签时也重新贴底；
    // load / error 不冒泡，只能在捕获阶段统一接住
    const onMedia = (event: Event) => {
      if (event.target instanceof HTMLImageElement) pin();
    };
    root.addEventListener('load', onMedia, true);
    root.addEventListener('error', onMedia, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener('load', onMedia, true);
      root.removeEventListener('error', onMedia, true);
    };
  }, [scrollRef, feedReady, targetId]);

  const loadOlder = async () => {
    const el = scrollRef?.current ?? scroller();
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    stick.current = false;
    await feed.fetchNextPage();
    requestAnimationFrame(() => {
      if (el) setScrollTop(el, el.scrollHeight - before);
    });
  };

  if (feed.isPending) return <FeedSkeleton />;
  if (feed.isError) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface px-4 py-10 text-center">
        <CloudOff size={20} strokeWidth={1.75} aria-hidden className="text-fg-subtle" />
        <p className="text-body text-fg">{tr('消息没加载出来')}</p>
        <p className="text-small text-fg-muted">{feed.error.message}</p>
        <Button size="sm" onClick={() => void feed.refetch()}>
          {tr('重试')}
        </Button>
      </div>
    );
  }

  const agentById = new Map((agents.data ?? []).map((a) => [a.id, a]));
  // 同屏循环动画不超过 3 个：只给最近的 2 个工作中的线程扫光
  const animatedThreadIds = new Set(
    messages
      .map((m) => (m.rootOfThreadId ? threadsById?.get(m.rootOfThreadId) : undefined))
      .filter((t) => t?.statusBucket === 'working')
      .slice(-2)
      .map((t) => t?.id),
  );

  return (
    <div ref={rootRef} className="relative">
      {targetId &&
        !messages.some((m) => m.id === targetId) &&
        (feed.data?.pages.length ?? 0) >= seekLimit &&
        feed.hasNextPage && (
          <Button size="sm" onClick={() => setSeekLimit((n) => n + MAX_SEEK_PAGES)}>
            {tr('继续定位历史消息')}
          </Button>
        )}
      {feed.hasNextPage && (
        <div className="flex justify-center py-3">
          <Button
            size="sm"
            variant="ghost"
            loading={feed.isFetchingNextPage}
            onClick={() => void loadOlder()}
          >
            {tr('加载更早的消息')}
          </Button>
        </div>
      )}
      {messages.length === 0 && drafts.length === 0 && empty}
      <div role="log" aria-label={tr('消息')} aria-live="polite" aria-relevant="additions">
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
          const compact =
            !newDay &&
            prev !== undefined &&
            prev.kind === 'text' &&
            m.kind === 'text' &&
            prev.author.id === m.author.id &&
            prev.author.kind === m.author.kind &&
            prev.agentVisible === m.agentVisible &&
            !prev.rootOfThreadId &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS;
          const thread = m.rootOfThreadId ? threadsById?.get(m.rootOfThreadId) : undefined;
          const agent = thread?.agentSessionId
            ? agentById.get(thread.agentSessionId)
            : thread
              ? (agents.data ?? []).find((a) => a.threadId === thread.id)
              : undefined;
          const working = thread?.statusBucket === 'working';
          const animate = working && animatedThreadIds.has(thread?.id);
          return (
            <div key={m.id}>
              {newDay && (
                <div className="pointer-events-none sticky top-0 z-[1] my-4 flex justify-center">
                  <span className="rounded-full border border-line bg-canvas/90 px-2.5 py-0.5 text-caption font-normal text-fg-subtle backdrop-blur">
                    {dayLabel(m.createdAt)}
                  </span>
                </div>
              )}
              <MessageItem
                projectId={projectId}
                message={m}
                me={me}
                compact={compact}
                onQuote={onQuote}
                readOnly={readOnly}
                animateIn={new Date(m.createdAt).getTime() > mountedAt}
                thread={thread}
                threadHref={thread && threadHref ? threadHref(thread) : undefined}
                threadActivity={animate ? (agent?.activity ?? tr('思考中')) : null}
                threadAgent={agent ?? null}
              />
            </div>
          );
        })}
        {drafts.map((d) => {
          const a = agentById.get(d.sessionId);
          const coordinator = a?.role === 'coordinator';
          const name = coordinator
            ? tr('协调者')
            : a?.role === 'personal'
              ? tr('个人智能体')
              : tr('线程智能体');
          return (
            <StreamingMessage
              key={d.sessionId}
              name={name}
              kind={coordinator ? 'coordinator' : 'agent'}
              text={d.text}
              activity={a?.activity}
            />
          );
        })}
      </div>
      <AnimatePresence>
        {unseen > 0 && (
          <motion.div
            variants={variants.fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="pointer-events-none sticky bottom-28 z-sticky flex justify-center"
          >
            <Button
              size="sm"
              variant="secondary"
              className="pointer-events-auto rounded-full shadow-md"
              leftIcon={<ArrowDown strokeWidth={1.75} aria-hidden />}
              onClick={() => {
                const el = scrollRef?.current ?? scroller();
                el?.scrollTo({
                  top: el.scrollHeight,
                  behavior: reducedMotion ? 'instant' : 'smooth',
                });
                setUnseen(0);
              }}
            >
              {tr('{unseen} 条新消息', { unseen })}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
