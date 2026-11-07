import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AgentProfile,
  AgentSession,
  ModelInfo,
  ReasoningEffort,
  SessionSettingsInput,
} from '@srh/shared';
import { EFFORT_LABEL } from '@srh/shared';
import { toast } from '@/components/ui';
import { Composer, type ComposerProps, type ComposerSubmit } from '@/components/chat/Composer';
import {
  ConversationAttachmentButton,
  ConversationAttachmentList,
} from '@/components/chat/ConversationAttachments';
import { useConversationAttachments } from '@/components/chat/conversation-attachments';
import { ComposerCredits } from '@/features/billing/components/ComposerCredits';
import { api } from '@/lib/api';
import { useHarness, useRunCommand } from '@/lib/harness';
import { qk } from '@/lib/query-keys';
import { useMeUser } from '@/lib/session';
import {
  effortForModelChange,
  matchEffort,
  matchModel,
  matchProfile,
  sessionView,
} from '../model-utils';
import {
  buildSlashItems,
  clampIndex,
  filterSlashItems,
  pickBehavior,
  resolveSlash,
  slashOptionId,
  slashQuery,
  type SlashItem,
} from '../slash';
import { stopResultTitle, useStopTurn } from '../stop';
import { SessionControls, type SessionControlFocus } from './SessionControls';
import { SlashHelpDialog } from './SlashHelpDialog';
import { SlashMenu } from './SlashMenu';
import { tr, trServer } from '@/lib/i18n';

export interface HarnessComposerProps extends Omit<
  ComposerProps,
  'menu' | 'onInputKeyDown' | 'inputAria'
> {
  projectId: string;
  /** commands/run 的目标：null = 项目协调者 */
  threadId: string | null;
  /** 当前 agent 会话；null = 还没有（新会话首屏）：只保留 help 和 prompt 类指令 */
  agent: AgentSession | null;
  /** 个人会话：/forward 可用 */
  personal?: boolean;
  /** 能发言、改会话设置 */
  writable: boolean;
  /** /forward：打开转给协调者的对话框 */
  onForward?: () => void;
  /** 新个人会话的配置在首次发送时一起提交。 */
  newSessionSettings?: {
    value: SessionSettingsInput;
    onChange: (value: SessionSettingsInput) => void;
  };
}

interface SettingsQueue {
  key: string;
  projectId: string;
  sessionId: string;
  pending: SessionSettingsInput | null;
  optimistic: SessionSettingsInput;
  busy: boolean;
  failed: boolean;
  error: string | null;
  listeners: Set<() => void>;
  announcement?: string;
}

interface SettingsQueueView {
  key: string;
  optimistic: SessionSettingsInput;
  pending: boolean;
  error: string | null;
}

// A session may be remounted while a write is in flight. Share its queue so that
// the new composer cannot overtake the old request.
const settingsQueues = new Map<string, SettingsQueue>();

function publishQueue(queue: SettingsQueue) {
  queue.listeners.forEach((listener) => listener());
}

function releaseQueue(queue: SettingsQueue) {
  if (!queue.listeners.size && !queue.busy && !queue.failed && !queue.pending) {
    if (settingsQueues.get(queue.key) === queue) settingsQueues.delete(queue.key);
  }
}

const SESSION_PENDING_TEXT: Record<string, string> = {
  compact: tr('正在压缩上下文…'),
  clear: tr('正在清空上下文…'),
};

function unavailableHint(name: string, hasSession: boolean): string {
  if (name === 'forward') return tr('只有个人会话可以转给协调者。');
  if (!hasSession) return tr('会话开始后才能用，先发一句话吧。');
  return tr('这个指令在这里用不了。');
}

/**
 * 带 harness 能力的输入框：在 Composer 外面加斜杠指令菜单、模型 / 强度 / profile 选择器。
 * 普通消息和 prompt 类指令（/goal、/plan、/skill、/<skill>、自定义）照常走页面的 onSubmit，
 * 由服务端在唤醒 agent 时展开；client 类在前端执行，session 类调 commands/run。
 */
export const HarnessComposer = forwardRef<HTMLTextAreaElement, HarnessComposerProps>(
  function HarnessComposer(
    {
      projectId,
      threadId,
      agent,
      personal = false,
      writable,
      onForward,
      newSessionSettings,
      value,
      onChange,
      onSubmit,
      onStop,
      toolbar,
      disabled,
      ...rest
    },
    ref,
  ) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => inputRef.current as HTMLTextAreaElement, []);
    const listId = useId();
    const queryClient = useQueryClient();
    const me = useMeUser();
    const channel = rest.channel ?? 'agent';
    const attachments = useConversationAttachments(me?.id, projectId, threadId, channel);
    const hasAttachmentControls = !newSessionSettings;
    const harness = useHarness(projectId);
    const run = useRunCommand(projectId);
    const stop = useStopTurn(projectId);

    const hasSession = Boolean(agent);
    const ctx = useMemo(() => ({ hasSession, personal }), [hasSession, personal]);
    const items = useMemo(() => buildSlashItems(harness.data, ctx), [harness.data, ctx]);
    const query = disabled ? null : slashQuery(value);
    const filtered = useMemo(
      () => (query === null ? [] : filterSlashItems(items, query)),
      [items, query],
    );

    // Esc 关掉的菜单：同一段输入不再弹出，改了输入再说
    const [dismissed, setDismissed] = useState<string | null>(null);
    // 高亮项跟着 query 走：query 变了回到第一项
    const [cursor, setCursor] = useState({ query: '', index: 0 });
    const menuOpen = query !== null && value !== dismissed && filtered.length > 0;
    const index = cursor.query === query ? clampIndex(cursor.index, filtered.length) : 0;

    const [picker, setPicker] = useState<{ open: boolean; focus: SessionControlFocus }>({
      open: false,
      focus: 'model',
    });
    const [helpOpen, setHelpOpen] = useState(false);

    const queueRef = useRef<SettingsQueue | null>(null);
    const [queueView, setQueueView] = useState<SettingsQueueView | null>(null);
    const sessionId = agent?.id;
    const queueKey = sessionId ? JSON.stringify([projectId, sessionId]) : null;
    useEffect(() => {
      if (!sessionId || !queueKey) {
        queueRef.current = null;
        setQueueView(null);
        return;
      }
      let queue = settingsQueues.get(queueKey);
      if (!queue) {
        queue = {
          key: queueKey,
          projectId,
          sessionId,
          pending: null,
          optimistic: {},
          busy: false,
          failed: false,
          error: null,
          listeners: new Set(),
        };
        settingsQueues.set(queueKey, queue);
      }
      const current = queue;
      const publish = () => {
        setQueueView({
          key: current.key,
          optimistic: { ...current.optimistic },
          pending: !current.failed && (current.busy || Boolean(current.pending)),
          error: current.error,
        });
        if (current.failed) setPicker((state) => ({ ...state, open: true }));
      };
      queue.listeners.add(publish);
      queueRef.current = queue;
      if (queue.busy || queue.failed || Object.keys(queue.optimistic).length) publish();
      return () => {
        current.listeners.delete(publish);
        if (queueRef.current === queue) queueRef.current = null;
        releaseQueue(current);
      };
    }, [sessionId, queueKey, projectId]);

    // Keep the optimistic value visible until the parent has received the saved session.
    useEffect(() => {
      const queue = queueRef.current;
      if (!agent || !queue || queue.key !== queueKey || queue.busy || queue.failed) return;
      if (!Object.keys(queue.optimistic).length) return;
      const matches = Object.entries(queue.optimistic).every(
        ([key, value]) => agent[key as 'model' | 'effort' | 'profile'] === value,
      );
      if (matches) {
        queue.optimistic = {};
        publishQueue(queue);
      }
    }, [agent, queueView, queueKey]);

    const catalog = harness.data?.catalog;
    const profiles = harness.data?.profiles;
    const activeQueueView = queueView?.key === queueKey ? queueView : null;
    const overlay = agent ? (activeQueueView?.optimistic ?? {}) : {};
    const initial = !agent ? newSessionSettings?.value : undefined;
    const initialProfile = profiles?.find((p) => p.slug === initial?.profile);
    const view = sessionView(
      catalog,
      profiles,
      agent
        ? {
            model: overlay.model ?? agent.model,
            effort: overlay.effort !== undefined ? overlay.effort : agent.effort,
            profile: overlay.profile !== undefined ? overlay.profile : agent.profile,
          }
        : initial
          ? {
              model: initial.model ?? catalog?.defaultModel ?? '',
              effort:
                initial.effort !== undefined ? initial.effort : (initialProfile?.effort ?? null),
              profile: initial.profile ?? null,
            }
          : null,
    );
    const canConfigure = hasSession && writable;

    const focusInput = (caretToEnd = false) => {
      window.setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        if (caretToEnd) el.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    };

    const handleChange = (next: string) => {
      if (dismissed !== null && next !== dismissed) setDismissed(null);
      onChange(next);
    };

    const commandAttachmentNotice = () => {
      if (hasAttachmentControls && attachments.files.length) {
        toast({
          title: tr('附件留在草稿'),
          description: tr('斜杠命令不会发送附件，可以稍后随消息发送。'),
        });
      }
    };

    const sendMessage = (message: ComposerSubmit) => {
      if (hasAttachmentControls && (attachments.isUploading || attachments.hasErrors)) return;
      onSubmit(
        hasAttachmentControls && attachments.fileIds.length
          ? { ...message, fileIds: attachments.fileIds }
          : message,
      );
    };

    // ------------------------------------------------------------ 会话设置

    const drainSettings = async (queue: SettingsQueue) => {
      if (queue.busy || queue.failed || !queue.pending) return;
      queue.busy = true;
      while (queue.pending) {
        const input = queue.pending;
        queue.pending = null;
        try {
          await queryClient.cancelQueries({ queryKey: qk.agents(queue.projectId) });
          const saved = await api.patch<AgentSession>(
            `/projects/${queue.projectId}/agents/${queue.sessionId}/settings`,
            input,
          );
          queryClient.setQueryData<AgentSession[]>(qk.agents(queue.projectId), (list) =>
            list?.map((item) => (item.id === saved.id ? saved : item)),
          );
          if (!queue.pending) {
            // Use the server's normalized values until the parent catches up.
            for (const key of Object.keys(queue.optimistic) as Array<
              'model' | 'effort' | 'profile'
            >) {
              Object.assign(queue.optimistic, { [key]: saved[key] });
            }
          }
        } catch (e) {
          queue.pending = Object.assign({}, input, queue.pending as SessionSettingsInput | null);
          queue.failed = true;
          queue.busy = false;
          const message = e instanceof Error ? e.message : tr('请稍后重试');
          queue.error = message;
          if (!queue.listeners.size) toast.error(tr('没能修改会话设置'), message);
          publishQueue(queue);
          return;
        }
      }
      queue.busy = false;
      queue.error = null;
      publishQueue(queue);
      if (queue.announcement && queue.listeners.size) toast.success(queue.announcement);
      queue.announcement = undefined;
      releaseQueue(queue);
    };

    const applySettings = (input: SessionSettingsInput, success?: string) => {
      if (!agent && newSessionSettings && writable) {
        newSessionSettings.onChange({ ...newSessionSettings.value, ...input });
        return;
      }
      if (!agent || !writable) {
        toast({
          title: tr('现在改不了会话设置'),
          description: unavailableHint('model', hasSession),
        });
        return;
      }
      const queue = queueRef.current;
      if (!queue || queue.key !== queueKey) return;
      queue.optimistic = { ...queue.optimistic, ...input };
      queue.pending = { ...queue.pending, ...input };
      queue.announcement = success;
      publishQueue(queue);
      void drainSettings(queue);
    };

    const retrySettings = () => {
      const queue = queueRef.current;
      if (!queue || queue.key !== queueKey) return;
      queue.failed = false;
      queue.error = null;
      publishQueue(queue);
      void drainSettings(queue);
    };

    const selectModel = (m: ModelInfo, announce = false) => {
      const currentEffort = agent
        ? queueRef.current?.key === queueKey && queueRef.current.optimistic.effort !== undefined
          ? queueRef.current.optimistic.effort
          : agent.effort
        : newSessionSettings?.value.effort;
      const effort = effortForModelChange(m, currentEffort);
      applySettings(
        { model: m.id, ...(effort === null ? { effort: agent ? null : undefined } : {}) },
        announce ? tr('已切换到 {name}', { name: m.name }) : undefined,
      );
    };

    const selectEffort = (e: ReasoningEffort, announce = false) => {
      applySettings(
        { effort: e },
        announce ? tr('推理强度：{value}', { value: EFFORT_LABEL[e] }) : undefined,
      );
    };

    const selectProfile = (p: AgentProfile | null, announce = false) => {
      applySettings(
        { profile: p?.slug ?? null },
        announce
          ? p
            ? tr('已切换到「{name}」', { name: trServer(p.name) })
            : tr('已不再使用 profile')
          : undefined,
      );
    };

    const openPicker = (focus: SessionControlFocus) => {
      if (!canConfigure) {
        toast({
          title: tr('现在改不了会话设置'),
          description: unavailableHint('model', hasSession),
        });
        return;
      }
      setPicker({ open: true, focus });
    };

    // ------------------------------------------------------------ 指令执行

    /** 前端指令；返回 true 表示已执行（清空草稿），false 表示参数有误（保留草稿）。 */
    const runClient = (name: string, args: string): boolean => {
      switch (name) {
        case 'help':
          setHelpOpen(true);
          return true;
        case 'model': {
          if (!args) {
            openPicker('model');
            return true;
          }
          const m = matchModel(catalog, args);
          if (!m) {
            toast.error(tr('找不到模型「{args}」', { args }), tr('输入 /model 打开列表挑一个。'));
            return false;
          }
          selectModel(m, true);
          return true;
        }
        case 'effort': {
          if (!args) {
            openPicker('effort');
            return true;
          }
          const e = matchEffort(args);
          if (!e || (view.model && !view.model.efforts.includes(e))) {
            const options = view.model?.efforts
              .map((x) => tr('{x}（{value}）', { x, value: EFFORT_LABEL[x] }))
              .join(tr('、'));
            toast.error(
              tr('当前模型不支持「{args}」', { args }),
              options ? tr('可选：{options}。', { options }) : tr('输入 /effort 打开列表挑一个。'),
            );
            return false;
          }
          selectEffort(e, true);
          return true;
        }
        case 'profile': {
          if (!args) {
            openPicker('profile');
            return true;
          }
          const p = matchProfile(profiles, args);
          if (p === undefined) {
            toast.error(
              tr('找不到 profile「{args}」', { args }),
              tr('输入 /profile 打开列表挑一个。'),
            );
            return false;
          }
          selectProfile(p, true);
          return true;
        }
        case 'forward':
          onForward?.();
          return true;
        case 'stop':
          // 页面给了停止回调（agent 正在回复）就交给页面；否则也调一次 stop：
          // agent 看起来空闲时，这一轮可能已经排上队，服务端会一起取消
          if (onStop) onStop();
          else if (agent && writable) {
            stop.mutate(agent.id, {
              onSuccess: (r) => {
                const title = stopResultTitle(r);
                toast(r.stopped === 'none' ? { title } : { tone: 'success', title });
              },
              onError: (e) => toast.error(tr('没能停止'), e.message),
            });
          } else toast({ title: tr('agent 现在没在回复') });
          return true;
        default:
          return false;
      }
    };

    const runSession = (name: string, args: string) => {
      if (!writable) return;
      const pendingText = SESSION_PENDING_TEXT[name];
      const pendingToast = pendingText ? toast({ title: pendingText, duration: 0 }) : null;
      run.mutate(
        { threadId, name, args },
        {
          onSuccess: (r) =>
            toast({
              tone: r.ok ? 'success' : 'warning',
              title: r.text || (r.ok ? tr('已完成') : tr('没有执行')),
            }),
          onError: (e) => toast.error(tr('/{name} 没执行成功', { name }), e.message),
          onSettled: () => {
            if (pendingToast !== null) toast.dismiss(pendingToast);
          },
        },
      );
    };

    const pick = (item: SlashItem) => {
      if (pickBehavior(item) === 'insert') {
        handleChange(`/${item.name} `);
        focusInput(true);
        return;
      }
      handleChange('');
      if (item.kind === 'session') {
        commandAttachmentNotice();
        runSession(item.name, '');
        focusInput();
      } else {
        if (runClient(item.name, '')) commandAttachmentNotice();
        if (item.name === 'stop') focusInput();
      }
    };

    const handleSubmit = (m: ComposerSubmit) => {
      // 团队讨论或指令目录尚未加载时，作为普通消息处理
      if (!m.agentVisible || !harness.data) {
        sendMessage(m);
        return;
      }
      const action = resolveSlash(m.body, items, ctx);
      switch (action.type) {
        case 'send':
          sendMessage(m);
          return;
        case 'client':
          if (runClient(action.name, action.args)) {
            commandAttachmentNotice();
            handleChange('');
          }
          return;
        case 'session':
          commandAttachmentNotice();
          handleChange('');
          runSession(action.name, action.args);
          return;
        case 'unavailable':
          toast({
            title: tr('/{name} 在这里用不了', { name: action.name }),
            description: unavailableHint(action.name, hasSession),
          });
      }
    };

    const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!menuOpen || query === null) return;
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      const len = filtered.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor({ query, index: clampIndex(index + (e.key === 'ArrowDown' ? 1 : -1), len) });
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        const item = filtered[index];
        if (item) pick(item);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(value);
      }
    };

    const controls =
      (agent || newSessionSettings) && harness.data ? (
        <SessionControls
          catalog={catalog}
          profiles={profiles ?? []}
          view={view}
          disabled={!writable || Boolean(!agent && disabled)}
          disabledReason={!writable ? tr('访客不能修改模型') : undefined}
          pending={activeQueueView?.pending}
          error={activeQueueView?.error}
          onRetry={retrySettings}
          open={picker.open}
          onOpenChange={(open) => setPicker((s) => ({ ...s, open }))}
          focus={picker.focus}
          onSelectModel={(m) => selectModel(m)}
          onSelectEffort={(e) => selectEffort(e)}
          onSelectProfile={(p) => selectProfile(p)}
        />
      ) : null;

    const slashAction =
      harness.data && channel === 'agent' ? resolveSlash(value, items, ctx) : null;
    const isCommand = slashAction?.type === 'client' || slashAction?.type === 'session';
    const attachmentBlocked =
      hasAttachmentControls && (attachments.isUploading || attachments.hasErrors);

    return (
      <>
        <Composer
          mentionProjectId={personal ? undefined : projectId}
          mentionDraftKey={
            !personal && me?.id
              ? `srh-mention-draft:v1:${me.id}:${projectId}:${threadId ?? 'project'}:${channel}`
              : undefined
          }
          ref={inputRef}
          {...rest}
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          onStop={onStop}
          disabled={disabled}
          sendDisabled={Boolean(rest.sendDisabled || (attachmentBlocked && !isCommand))}
          toolbar={
            controls || toolbar || hasAttachmentControls ? (
              <>
                {controls}
                {controls && (
                  <ComposerCredits
                    projectId={projectId}
                    personal={personal}
                    modelId={view.model?.id ?? null}
                  />
                )}
                {hasAttachmentControls && (
                  <ConversationAttachmentButton
                    attachments={attachments}
                    disabled={!writable || disabled || !me?.id}
                  />
                )}
                {toolbar}
              </>
            ) : undefined
          }
          onInputKeyDown={onInputKeyDown}
          inputAria={{
            role: 'combobox',
            'aria-expanded': menuOpen,
            'aria-autocomplete': 'list',
            ...(menuOpen
              ? { 'aria-controls': listId, 'aria-activedescendant': slashOptionId(listId, index) }
              : {}),
          }}
          menu={
            <>
              {hasAttachmentControls && (
                <ConversationAttachmentList
                  attachments={attachments}
                  disabled={!writable || disabled}
                />
              )}
              <AnimatePresence>
                {menuOpen && (
                  <SlashMenu
                    key="slash-menu"
                    id={listId}
                    items={filtered}
                    index={index}
                    grouped={query === ''}
                    onHover={(i) => setCursor({ query: query ?? '', index: i })}
                    onPick={pick}
                  />
                )}
              </AnimatePresence>
            </>
          }
        />
        <SlashHelpDialog open={helpOpen} onOpenChange={setHelpOpen} items={items} />
      </>
    );
  },
);
