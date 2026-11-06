import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Cpu, Search, X } from 'lucide-react';
import {
  EFFORT_LABEL,
  type AgentProfile,
  type ModelCatalog,
  type ModelInfo,
  type ReasoningEffort,
} from '@srh/shared';
import { Input, Popover, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  groupModels,
  hasEffortChoice,
  modelLabel,
  shortModelLabel,
  type SessionModelView,
} from '../model-utils';
import { ProfileGlyph } from './ProfileGlyph';
import './effort-slider.css';
import { tr } from '@/lib/i18n';

export type SessionControlFocus = 'model' | 'effort' | 'profile';

export interface SessionControlsProps {
  catalog: ModelCatalog | undefined;
  profiles: AgentProfile[];
  view: SessionModelView;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
  error?: string | null;
  onRetry?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focus: SessionControlFocus;
  onSelectModel: (model: ModelInfo) => void;
  onSelectEffort: (effort: ReasoningEffort) => void;
  onSelectProfile: (profile: AgentProfile | null) => void;
}

const TRIGGER =
  'press inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-sm px-2 text-small text-fg-muted max-md:h-9';

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-2 pb-1 text-caption text-fg-subtle">{children}</div>;
}

function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-option]'));
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next]?.focus();
}

function OptionRow({
  selected,
  autoFocus,
  onSelect,
  title,
  detail,
  icon,
}: {
  selected: boolean;
  autoFocus?: boolean;
  onSelect: () => void;
  title: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-option
      data-autofocus={autoFocus || undefined}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-9 w-full cursor-pointer items-start gap-2.5 rounded-sm px-2 py-1.5 text-left outline-none max-md:min-h-11',
        'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
        'hover:bg-subtle focus-visible:bg-subtle',
        selected && 'bg-accent-soft hover:bg-accent-soft',
      )}
    >
      {icon && <span className="mt-0.5 flex shrink-0 text-fg-muted [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span
          className={cn('block break-words text-body', selected ? 'text-accent-text' : 'text-fg')}
        >
          {title}
        </span>
        {detail && (
          <span className="block text-caption font-normal text-pretty text-fg-subtle">
            {detail}
          </span>
        )}
      </span>
      {selected && (
        <Check size={16} strokeWidth={2} aria-hidden className="mt-0.5 shrink-0 text-accent" />
      )}
    </button>
  );
}

function EffortSlider({
  model,
  effort,
  autoFocus,
  onSelect,
}: {
  model: ModelInfo;
  effort: ReasoningEffort | null;
  autoFocus: boolean;
  onSelect: (effort: ReasoningEffort) => void;
}) {
  const current = Math.max(0, model.efforts.indexOf(effort ?? model.defaultEffort));
  const [preview, setPreview] = useState(current);
  const dragging = useRef(false);
  const previewRef = useRef(current);
  useEffect(() => {
    if (!dragging.current) {
      previewRef.current = current;
      setPreview(current);
    }
  }, [current, model.id]);
  const commit = (index: number) => {
    const selected = model.efforts[index];
    if (selected) onSelect(selected);
  };
  return (
    <div className="px-2 pt-2 pb-2">
      <div className="flex items-center justify-between text-small text-fg-muted">
        <span>{tr('推理强度')}</span>
        <span className="font-medium tabular-nums text-fg">
          {EFFORT_LABEL[model.efforts[preview] ?? model.defaultEffort]}
        </span>
      </div>
      <div className="effort-control" style={{ marginInline: `${50 / model.efforts.length}%` }}>
        <div className="effort-rail" aria-hidden="true">
          <span
            className="effort-fill"
            style={{ width: `${(preview / Math.max(1, model.efforts.length - 1)) * 100}%` }}
          />
          <span
            className="effort-thumb"
            style={{ left: `${(preview / Math.max(1, model.efforts.length - 1)) * 100}%` }}
          />
        </div>
        <input
          type="range"
          aria-label={tr('推理强度')}
          aria-valuetext={EFFORT_LABEL[model.efforts[preview] ?? model.defaultEffort]}
          data-autofocus={autoFocus || undefined}
          min={0}
          max={model.efforts.length - 1}
          step={1}
          value={preview}
          className="effort-slider"
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            previewRef.current = next;
            setPreview(next);
            if (!dragging.current) commit(next);
          }}
          onPointerUp={() => {
            if (!dragging.current) return;
            dragging.current = false;
            commit(previewRef.current);
          }}
          onPointerCancel={() => {
            dragging.current = false;
            previewRef.current = current;
            setPreview(current);
          }}
        />
      </div>
      <div className="flex justify-between gap-0">
        {model.efforts.map((item, index) => (
          <button
            key={item}
            type="button"
            aria-label={tr('推理强度：{value}', { value: EFFORT_LABEL[item] })}
            aria-pressed={preview === index}
            className={cn(
              'relative min-h-9 min-w-0 flex-1 cursor-pointer rounded-sm px-0.5 pt-2 text-caption hover:bg-subtle max-md:min-h-11',
              preview === index ? 'font-medium text-fg' : 'text-fg-subtle',
            )}
            onClick={() => {
              previewRef.current = index;
              setPreview(index);
              commit(index);
            }}
          >
            <span
              aria-hidden
              className={cn(
                'absolute top-0 left-1/2 h-1 w-px',
                preview === index ? 'bg-accent' : 'bg-line-strong',
              )}
            />
            {EFFORT_LABEL[item]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 模型、强度与科研角色共用的紧凑配置面板。 */
export function SessionControls({
  catalog,
  profiles,
  view,
  disabled,
  disabledReason,
  pending,
  error,
  onRetry,
  open,
  onOpenChange,
  focus,
  onSelectModel,
  onSelectEffort,
  onSelectProfile,
}: SessionControlsProps) {
  const [navigation, setNavigation] = useState<{
    open: boolean;
    focus: SessionControlFocus;
    page: 'settings' | 'profile';
    query: string;
  }>({ open, focus, page: open && focus === 'profile' ? 'profile' : 'settings', query: '' });
  let currentNavigation = navigation;
  if (navigation.open !== open || navigation.focus !== focus) {
    currentNavigation = {
      open,
      focus,
      page: open && focus === 'profile' ? 'profile' : 'settings',
      query: '',
    };
    setNavigation(currentNavigation);
  }
  const { page, query } = currentNavigation;
  const setPage = (next: 'settings' | 'profile') =>
    setNavigation((state) => ({ ...state, page: next }));
  const setQuery = (next: string) => setNavigation((state) => ({ ...state, query: next }));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const roleButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rolesRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || focus === 'profile') return;
    const timer = window.setTimeout(() => {
      const target =
        settingsRef.current?.querySelector<HTMLElement>('[data-autofocus]') ??
        settingsRef.current?.querySelector<HTMLElement>('[data-option]');
      target?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, focus]);
  useEffect(() => {
    if (open && page === 'profile') searchRef.current?.focus();
  }, [open, page]);
  const changeOpen = (next: boolean) => {
    onOpenChange(next);
    if (!next) window.setTimeout(() => triggerRef.current?.focus(), 0);
  };
  const returnToSettings = () => {
    setPage('settings');
    setQuery('');
    window.setTimeout(() => roleButtonRef.current?.focus(), 0);
  };
  const label = modelLabel(view.model, view.effort);
  const shortLabel = shortModelLabel(view.model, view.effort);
  const content = (
    <>
      <Cpu size={15} strokeWidth={1.75} aria-hidden className="shrink-0" />
      {view.profile && (
        <span className="inline-flex max-w-16 shrink-0 items-center gap-1 truncate sm:max-w-28">
          <ProfileGlyph icon={view.profile.icon} size={13} className="shrink-0 text-agent" />
          <span className="truncate">{view.profile.name}</span>
          <span aria-hidden className="text-fg-subtle">
            ·
          </span>
        </span>
      )}
      {/* 手机上显示短名（去掉厂商词），完整名在 title 与 aria-label 里 */}
      <span className="min-w-0 truncate sm:hidden">{shortLabel}</span>
      <span className="hidden min-w-0 truncate sm:inline">{label}</span>
    </>
  );
  if (disabled)
    return (
      <Tooltip content={disabledReason ?? label} disabled={!disabledReason}>
        <span
          tabIndex={disabledReason ? 0 : undefined}
          className={cn(TRIGGER, 'max-w-44 cursor-default opacity-70 sm:max-w-72')}
          aria-label={tr('当前模型：{label}', { label })}
        >
          {content}
        </span>
      </Tooltip>
    );
  const groups = groupModels(catalog);
  const model = view.model;
  const roleOptions = [null, ...profiles].filter((p) =>
    `${p?.name ?? tr('通用')} ${p?.description ?? tr('不附加角色设定')}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <Popover
      open={open}
      onOpenChange={changeOpen}
      side="top"
      align="start"
      autoFocus={false}
      label={tr('模型、推理强度与科研角色')}
      className={cn(
        'w-[min(22rem,calc(100vw-1rem))] p-1',
        // 角色页：面板本身不滚，只让角色列表滚，避免两层滚动条
        page === 'profile' && 'flex flex-col overflow-hidden',
      )}
      trigger={
        <button
          ref={triggerRef}
          type="button"
          title={label}
          aria-label={tr('模型与推理强度：{label}{value}', {
            label,
            value: view.profile ? tr('，科研角色：{name}', { name: view.profile.name }) : '',
          })}
          className={cn(
            TRIGGER,
            'max-w-44 cursor-pointer hover:bg-subtle hover:text-fg aria-expanded:bg-subtle aria-expanded:text-fg sm:max-w-72',
          )}
        >
          {content}
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
        </button>
      }
    >
      <div className="flex shrink-0 items-center justify-between py-1 pl-2">
        {page === 'profile' ? (
          <button
            type="button"
            onClick={returnToSettings}
            className="flex min-h-9 items-center gap-1 text-small text-fg-muted hover:text-fg max-md:min-h-11"
          >
            <ArrowLeft size={15} />
            {tr('返回配置')}
          </button>
        ) : (
          <span className="flex items-center gap-3 text-small font-medium">
            {tr('会话配置')}
            <span role="status" className="w-14 text-caption font-normal text-fg-subtle">
              {pending ? tr('保存中…') : ''}
            </span>
          </span>
        )}
        <button
          type="button"
          aria-label={tr('关闭配置')}
          onClick={() => changeOpen(false)}
          className="grid size-9 place-items-center rounded-sm text-fg-muted hover:bg-subtle max-md:size-11"
        >
          <X size={16} />
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="mx-2 mb-2 shrink-0 rounded-md bg-danger-soft p-2 text-small text-danger"
        >
          <span>{tr('设置未保存：{error}', { error })}</span>{' '}
          {onRetry && (
            <button type="button" onClick={onRetry} className="font-medium underline">
              {tr('重试')}
            </button>
          )}
        </div>
      )}
      {page === 'settings' ? (
        <div ref={settingsRef} onKeyDown={onPanelKeyDown} className="flex flex-col">
          <SectionLabel>{tr('模型')}</SectionLabel>
          {groups.length === 0 && (
            <p className="px-2 pb-2 text-small text-fg-muted">
              {tr('还没有可用的模型，请负责人在设置里配置。')}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={g.name} className="flex flex-col">
              {groups.length > 1 && (
                <div className="px-2 pt-1 pb-0.5 text-caption text-fg-subtle">{g.name}</div>
              )}
              {g.models.map((m) => (
                <OptionRow
                  key={m.id}
                  selected={m.id === model?.id}
                  autoFocus={focus === 'model' && m.id === model?.id}
                  onSelect={() => onSelectModel(m)}
                  title={m.name}
                  detail={m.description}
                />
              ))}
            </div>
          ))}
          {model && hasEffortChoice(model) && (
            <>
              <div role="separator" className="-mx-1 my-1 h-px bg-line" />
              <EffortSlider
                key={model.id}
                model={model}
                effort={view.effort}
                autoFocus={focus === 'effort'}
                onSelect={onSelectEffort}
              />
            </>
          )}
          <div role="separator" className="-mx-1 my-1 h-px bg-line" />
          <button
            ref={roleButtonRef}
            type="button"
            onClick={() => setPage('profile')}
            className="flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left hover:bg-subtle"
          >
            <ProfileGlyph icon={view.profile?.icon} size={16} className="shrink-0 text-agent" />
            <span className="min-w-0 flex-1">
              <span className="block text-caption text-fg-subtle">{tr('科研角色')}</span>
              <span className="block truncate text-small">{view.profile?.name ?? tr('通用')}</span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-fg-muted" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-auto flex-col">
          <div className="shrink-0 px-1 pt-0.5 pb-1.5">
            <Input
              ref={searchRef}
              aria-label={tr('搜索科研角色')}
              placeholder={tr('搜索角色')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                const options = rolesRef.current?.querySelectorAll<HTMLButtonElement>('button');
                if (!options?.length) return;
                e.preventDefault();
                options[e.key === 'ArrowDown' ? 0 : options.length - 1]?.focus();
              }}
              leading={<Search size={15} />}
            />
          </div>
          <div
            ref={rolesRef}
            role="radiogroup"
            aria-label={tr('科研角色')}
            className="max-h-[min(22rem,55dvh)] min-h-0 flex-auto overflow-y-auto overscroll-contain"
            onKeyDown={(e) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
              if (!buttons.length) return;
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? buttons.length - 1
                    : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }}
          >
            {roleOptions.map((p) => {
              const selected = (p?.slug ?? null) === (view.profile?.slug ?? null);
              return (
                <button
                  key={p?.slug ?? '__none'}
                  type="button"
                  role="radio"
                  aria-label={p?.name ?? tr('通用')}
                  aria-checked={selected}
                  className={cn(
                    'flex min-h-11 w-full cursor-pointer items-start gap-2.5 rounded-sm px-2 py-2 text-left outline-none',
                    'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                    'hover:bg-subtle focus-visible:bg-subtle',
                    selected && 'bg-accent-soft hover:bg-accent-soft',
                  )}
                  onClick={() => {
                    onSelectProfile(p);
                    returnToSettings();
                  }}
                >
                  <ProfileGlyph
                    icon={p?.icon}
                    size={16}
                    className={cn('mt-0.5 shrink-0', selected ? 'text-accent' : 'text-fg-muted')}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block break-words text-body',
                        selected ? 'text-accent-text' : 'text-fg',
                      )}
                    >
                      {p?.name ?? tr('通用')}
                    </span>
                    <span className="mt-0.5 block text-caption break-words text-pretty text-fg-subtle">
                      {p?.description ?? tr('不附加角色设定')}
                    </span>
                  </span>
                  {selected && (
                    <Check
                      size={16}
                      strokeWidth={2}
                      className="mt-0.5 shrink-0 text-accent"
                      aria-hidden
                    />
                  )}
                </button>
              );
            })}
            {!roleOptions.length && (
              <p className="px-2 py-4 text-small text-fg-muted">{tr('没有匹配的角色')}</p>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
