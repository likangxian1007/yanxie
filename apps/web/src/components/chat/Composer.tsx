import type { MessageMention } from '@srh/shared';
import { useMemberMentions } from './MemberMentionMenu';
import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

export interface ComposerSubmit {
  body: string;
  mentions?: MessageMention[];
  fileIds?: string[];
  /** false = 团队讨论：仅成员可见，不进入智能体上下文 */
  agentVisible: boolean;
}

export interface ComposerProps {
  mentionProjectId?: string | undefined;
  initialMentions?: MessageMention[];
  mentionDraftKey?: string | undefined;
  onInputSelect?: (() => void) | undefined;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (message: ComposerSubmit) => void;
  placeholder?: string;
  disabled?: boolean;
  sendDisabled?: boolean;
  className?: string;
  /** 读屏标签 */
  label?: string;
  channel?: 'agent' | 'team';
  /** 输入时回调（上报 typing） */
  onTyping?: () => void;
  /** 不吸底（嵌在页面中间用） */
  inline?: boolean;
  /** agent 正在回复时显示“停止”按钮 */
  onStop?: (() => void) | undefined;
  /** 工具栏左侧的附加内容 */
  toolbar?: ReactNode;
  /** 输入框下方的提示（例如只读原因） */
  footnote?: ReactNode;
  /** 浮在输入框上方的菜单（斜杠指令），相对表单定位 */
  menu?: ReactNode;
  /** 先于发送逻辑处理按键；调用 preventDefault 后不再发送 */
  onInputKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** 给 textarea 的组合框属性（菜单打开时的 aria-activedescendant 等） */
  inputAria?: {
    role?: 'combobox';
    'aria-expanded'?: boolean;
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    'aria-autocomplete'?: 'list';
  };
}

/**
 * 聊天输入（STYLE §6 Composer）：rounded-xl 白底卡片，自动增高到 40vh；
 * Enter 发送、Shift+Enter 换行，输入法组合中不发送；有内容时发送按钮从 subtle 变 accent。
 */
const PlainComposer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  {
    value,
    onChange,
    onSubmit,
    placeholder = tr('向协调者描述需求…'),
    disabled,
    sendDisabled,
    className,
    label = tr('给协调者的消息'),
    channel = 'agent',
    onTyping,
    inline,
    onStop,
    toolbar,
    footnote,
    menu,
    onInputKeyDown,
    inputAria,
    onInputSelect,
  },
  forwardedRef,
) {
  const inputId = useId();
  const hintId = useId();
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const sideChat = channel === 'team';
  const canSend = value.trim().length > 0 && !disabled && !sendDisabled;

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useImperativeHandle(forwardedRef, () => innerRef.current as HTMLTextAreaElement, []);

  const submit = () => {
    if (!canSend) return;
    onSubmit({ body: value.trim(), agentVisible: !sideChat });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onInputKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 输入法组合中（含 Safari 组合结束那一下的 229）不发送
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  return (
    <div
      className={cn(
        !inline && [
          'sticky bottom-0 z-sticky bg-linear-to-t from-canvas from-60% to-transparent px-4 pt-5 md:px-6',
          // 手机上标签栏在下面时安全区归它（--safe-bottom 为 0），只留 12px
          'pb-[max(var(--safe-bottom),0.75rem)] md:pb-6',
        ],
        className,
      )}
    >
      <form
        onSubmit={onFormSubmit}
        className={cn(
          'relative mx-auto w-full max-w-(--feed-max) rounded-xl border bg-surface shadow-sm',
          'transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard)',
          'focus-within:border-line-strong focus-within:shadow-md',
          'border-line',
        )}
      >
        {menu}
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <textarea
          ref={innerRef}
          {...inputAria}
          id={inputId}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={hintId}
          onChange={(e) => {
            onChange(e.target.value);
            onTyping?.();
          }}
          onSelect={onInputSelect}
          onKeyDown={onKeyDown}
          className={cn(
            'block max-h-[40vh] min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-prose text-fg',
            'placeholder:text-fg-subtle focus-visible:outline-none disabled:cursor-not-allowed',
          )}
        />
        <div className="flex items-center gap-1 px-2 pt-1 pb-2">
          {toolbar}

          <span
            id={hintId}
            className="ml-auto hidden pr-2 text-caption font-normal text-fg-subtle sm:inline"
          >
            {tr('Enter 发送 · Shift + Enter 换行')}
          </span>

          {onStop && (
            <button
              type="button"
              aria-label={tr('停止智能体回复')}
              onClick={onStop}
              className="press ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-md bg-fg text-fg-inverse max-md:size-10 sm:ml-0"
            >
              <Square size={12} strokeWidth={2.5} fill="currentColor" aria-hidden />
            </button>
          )}
          {(canSend || !onStop) && (
            <button
              type="submit"
              aria-label={tr('发送')}
              disabled={!canSend}
              className={cn(
                'press ml-auto grid size-8 shrink-0 place-items-center rounded-md max-md:size-10 sm:ml-0',
                'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                canSend
                  ? 'cursor-pointer bg-accent-solid text-accent-fg shadow-xs hover:bg-accent-solid-hover'
                  : 'cursor-not-allowed bg-subtle text-fg-subtle',
              )}
            >
              <ArrowUp size={16} strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
      </form>
      {footnote && (
        <p className="mx-auto mt-2 max-w-(--feed-max) text-center text-caption font-normal text-fg-subtle">
          {footnote}
        </p>
      )}
    </div>
  );
});

const MentionComposer = forwardRef<HTMLTextAreaElement, ComposerProps>(
  function MentionComposer(props, ref) {
    const input = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => input.current as HTMLTextAreaElement, []);
    const mention = useMemberMentions({
      pid: props.mentionProjectId,
      value: props.value,
      initial: props.initialMentions,
      draftKey: props.mentionDraftKey,
      onChange: props.onChange,
      input,
    });
    return (
      <PlainComposer
        {...props}
        ref={input}
        onChange={mention.change}
        onInputSelect={mention.onSelect}
        inputAria={mention.aria ?? props.inputAria}
        menu={mention.menu ?? props.menu}
        onInputKeyDown={(event) => {
          mention.onKeyDown(event);
          if (!event.defaultPrevented) props.onInputKeyDown?.(event);
        }}
        onSubmit={(message) => {
          const mentions = mention.mentions();
          props.onSubmit({ ...message, ...(mentions.length ? { mentions } : {}) });
        }}
      />
    );
  },
);
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(
  function Composer(props, ref) {
    return props.mentionProjectId ? (
      <MentionComposer {...props} ref={ref} />
    ) : (
      <PlainComposer {...props} ref={ref} />
    );
  },
);
