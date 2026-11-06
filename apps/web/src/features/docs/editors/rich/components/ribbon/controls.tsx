import { useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { ChevronDown, Palette } from 'lucide-react';
import {
  Button,
  type ButtonProps,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
  Separator,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { shortcutLabel } from '../../lib/text';
import { ICON_STROKE } from '../icons';
import {
  CN_FONT_SIZES,
  DEFAULT_TEXT_COLOR,
  FONT_FAMILIES,
  LINE_HEIGHTS,
  PT_FONT_SIZES,
  fontLabel,
  normalizeColor,
  ptValue,
  sizeLabel,
  toPt,
} from '../../word/format';
import { LIST_STYLES, type ListStyle } from '../../word/schema';
import { tr } from '@/lib/i18n';

export const ACTIVE = 'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text';

export function Tool({
  label,
  shortcut,
  active,
  disabled,
  danger,
  onClick,
  onDoubleClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      size="sm"
      label={label}
      {...(shortcut ? { shortcut: shortcutLabel(shortcut) } : {})}
      {...(active !== undefined ? { 'aria-pressed': active } : {})}
      disabled={disabled}
      className={cn(active && ACTIVE, danger && 'hover:bg-danger-soft hover:text-danger')}
      onClick={onClick}
      {...(onDoubleClick ? { onDoubleClick } : {})}
    >
      {children}
    </IconButton>
  );
}

export function Divider() {
  return <Separator orientation="vertical" className="mx-1 my-1.5 h-4 self-center" />;
}

/** 带文字的下拉按钮（字体、字号、段落样式） */
export function DropButton({
  label,
  children,
  width,
  className,
  ...rest
}: {
  label: string;
  children: ReactNode;
  width?: string;
  className?: string;
} & Omit<ButtonProps, 'children' | 'size' | 'variant'>) {
  return (
    <Button
      {...rest}
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      className={cn(
        'min-w-0 shrink-0 justify-between gap-1 overflow-hidden px-2',
        width,
        className,
      )}
      rightIcon={<ChevronDown strokeWidth={ICON_STROKE} />}
    >
      <span className="min-w-0 truncate">{children}</span>
    </Button>
  );
}

// ---------------------------------------------------------------- 字体 / 字号

export function FontFamilyMenu({ editor, value }: { editor: Editor; value: string | null }) {
  const chain = () => editor.chain().focus();
  const name = fontLabel(value);
  return (
    <Menu
      label={tr('字体')}
      className="max-h-80"
      trigger={
        <DropButton label={tr('字体：{name}', { name })} width="w-28">
          {name}
        </DropButton>
      }
    >
      <MenuItem checked={!value} onSelect={() => chain().unsetFontFamily().run()}>
        {tr('默认字体')}
      </MenuItem>
      <MenuSeparator />
      {FONT_FAMILIES.map((f) => (
        <MenuItem
          key={f.label}
          checked={value === f.value}
          onSelect={() => chain().setFontFamily(f.value).run()}
        >
          <span style={{ fontFamily: f.value }}>{f.label}</span>
        </MenuItem>
      ))}
    </Menu>
  );
}

export function FontSizeMenu({ editor, value }: { editor: Editor; value: string | null }) {
  const chain = () => editor.chain().focus();
  const pt = toPt(value);
  const label = value ? sizeLabel(value) : tr('字号');
  const [custom, setCustom] = useState('');
  return (
    <Menu
      label={tr('字号')}
      className="max-h-96"
      trigger={
        <DropButton
          label={tr('字号：{value}', { value: value ? label : tr('默认') })}
          width="w-[4.5rem]"
        >
          {value ? label : tr('字号')}
        </DropButton>
      }
    >
      <MenuItem checked={!value} onSelect={() => chain().unsetFontSize().run()}>
        {tr('默认')}
      </MenuItem>
      <form
        className="px-2 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(custom);
          if (Number.isFinite(n) && n >= 1 && n <= 400) chain().setFontSize(ptValue(n)).run();
        }}
      >
        <input
          inputMode="decimal"
          aria-label={tr('自定义字号（磅）')}
          placeholder={tr('输入磅值，回车')}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-7 w-full rounded-sm border border-line-strong bg-surface px-2 text-small text-fg outline-none focus:border-accent"
        />
      </form>
      <MenuLabel>{tr('中文字号')}</MenuLabel>
      {CN_FONT_SIZES.map((s) => (
        <MenuItem
          key={s.label}
          checked={pt === s.pt}
          shortcut={`${s.pt}`}
          onSelect={() => chain().setFontSize(ptValue(s.pt)).run()}
        >
          {s.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>{tr('磅')}</MenuLabel>
      {PT_FONT_SIZES.map((s) => (
        <MenuItem key={s} checked={pt === s} onSelect={() => chain().setFontSize(ptValue(s)).run()}>
          {s}
        </MenuItem>
      ))}
    </Menu>
  );
}

// ---------------------------------------------------------------- 颜色

/**
 * 颜色面板：色块、“自动 / 无”、自定义颜色。value 是当前颜色（#rrggbb 或 null）。
 */
export function ColorMenu({
  label,
  icon,
  value,
  colors,
  noneLabel,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  value: string | null;
  colors: { label: string; value: string }[];
  noneLabel: string;
  onPick: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = normalizeColor(value);
  return (
    <Popover
      label={label}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton size="sm" label={label} className="relative">
          <span className="flex flex-col items-center">
            {icon}
            <span
              aria-hidden
              className="-mt-0.5 h-1 w-4 rounded-full border border-line"
              style={current ? { backgroundColor: current } : undefined}
            />
          </span>
        </IconButton>
      }
    >
      {(close) => (
        <div className="flex w-56 flex-col gap-2 p-1.5">
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-sm px-2 text-small text-fg hover:bg-subtle"
            onClick={() => {
              onPick(null);
              close();
            }}
          >
            <span aria-hidden className="size-4 rounded-sm border border-line-strong" />
            {noneLabel}
          </button>
          <div className="grid grid-cols-7 gap-1" role="listbox" aria-label={label}>
            {colors.map((c) => (
              <button
                key={c.value}
                type="button"
                role="option"
                aria-selected={current === c.value}
                aria-label={c.label}
                title={c.label}
                className={cn(
                  'size-7 rounded-sm border border-line transition-transform duration-(--dur-fast) hover:scale-110',
                  current === c.value && 'ring-2 ring-accent ring-offset-1 ring-offset-elevated',
                )}
                style={{ backgroundColor: c.value }}
                onClick={() => {
                  onPick(c.value);
                  close();
                }}
              />
            ))}
          </div>
          <label className="flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-small text-fg hover:bg-subtle">
            <Palette size={16} strokeWidth={ICON_STROKE} aria-hidden className="text-fg-muted" />
            <span className="flex-1">{tr('其他颜色')}</span>
            <input
              type="color"
              aria-label={tr('自定义颜色')}
              className="size-6 cursor-pointer border-0 bg-transparent p-0"
              value={current ?? DEFAULT_TEXT_COLOR}
              onChange={(e) => onPick(e.target.value)}
            />
          </label>
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------- 行距与段落间距

export function LineSpacingMenu({
  editor,
  value,
  before,
  after,
  icon,
}: {
  editor: Editor;
  value: string | null;
  before: number | null;
  after: number | null;
  icon: ReactNode;
}) {
  const chain = () => editor.chain().focus();
  return (
    <Menu
      label={tr('行距与段落间距')}
      trigger={
        <IconButton size="sm" label={tr('行距与段落间距')}>
          {icon}
        </IconButton>
      }
    >
      <MenuLabel>{tr('行距（倍）')}</MenuLabel>
      <MenuItem checked={!value} onSelect={() => chain().setLineHeight(null).run()}>
        {tr('默认')}
      </MenuItem>
      {LINE_HEIGHTS.map((h) => (
        <MenuItem key={h} checked={value === h} onSelect={() => chain().setLineHeight(h).run()}>
          {h}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        onSelect={() =>
          chain()
            .setParagraphSpacing({ before: before ? null : 12 })
            .run()
        }
      >
        {before ? tr('删除段前间距') : tr('增加段前间距（12 磅）')}
      </MenuItem>
      <MenuItem
        onSelect={() =>
          chain()
            .setParagraphSpacing({ after: after ? null : 12 })
            .run()
        }
      >
        {after ? tr('删除段后间距') : tr('增加段后间距（12 磅）')}
      </MenuItem>
    </Menu>
  );
}

export function SpacingMenu({
  editor,
  which,
  value,
}: {
  editor: Editor;
  which: 'before' | 'after';
  value: number | null;
}) {
  const label = which === 'before' ? tr('段前') : tr('段后');
  return (
    <Menu
      label={tr('{label}间距', { label })}
      trigger={
        <DropButton
          label={tr('{label}间距：{value} 磅', { label, value: value ?? 0 })}
          width="w-[5.5rem]"
        >
          {label} {value ?? 0}
        </DropButton>
      }
    >
      {[0, 3, 6, 8, 10, 12, 18, 24].map((pt) => (
        <MenuItem
          key={pt}
          checked={(value ?? 0) === pt}
          onSelect={() =>
            editor
              .chain()
              .focus()
              .setParagraphSpacing({ [which]: pt || null })
              .run()
          }
        >
          {tr('{pt} 磅', { pt })}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function IndentMenu({ editor, value }: { editor: Editor; value: number | null }) {
  const chain = () => editor.chain().focus();
  const label = !value
    ? tr('无')
    : value > 0
      ? tr('首行 {value} 字符', { value })
      : tr('悬挂 {value} 字符', { value: -value });
  return (
    <Menu
      label={tr('特殊缩进')}
      trigger={
        <DropButton label={tr('特殊缩进：{label}', { label })} width="w-[6.5rem]">
          {label}
        </DropButton>
      }
    >
      <MenuItem checked={!value} onSelect={() => chain().setTextIndent(null).run()}>
        {tr('无')}
      </MenuItem>
      <MenuItem checked={value === 2} onSelect={() => chain().setTextIndent(2).run()}>
        {tr('首行缩进 2 字符')}
      </MenuItem>
      <MenuItem checked={value === 4} onSelect={() => chain().setTextIndent(4).run()}>
        {tr('首行缩进 4 字符')}
      </MenuItem>
      <MenuItem checked={value === -2} onSelect={() => chain().setTextIndent(-2).run()}>
        {tr('悬挂缩进 2 字符')}
      </MenuItem>
    </Menu>
  );
}

// ---------------------------------------------------------------- 列表（拆分按钮）

export function ListButton({
  editor,
  ordered,
  active,
  current,
  icon,
}: {
  editor: Editor;
  ordered: boolean;
  active: boolean;
  current: string | null;
  icon: ReactNode;
}) {
  const label = ordered ? tr('编号') : tr('项目符号');
  const styles = (Object.keys(LIST_STYLES) as ListStyle[]).filter(
    (k) => LIST_STYLES[k].ordered === ordered,
  );
  return (
    <span className="inline-flex items-center">
      <Tool
        label={label}
        shortcut={ordered ? 'Mod-Shift-7' : 'Mod-Shift-8'}
        active={active}
        onClick={() =>
          ordered
            ? editor.chain().focus().toggleOrderedList().run()
            : editor.chain().focus().toggleBulletList().run()
        }
      >
        {icon}
      </Tool>
      <Menu
        label={tr('{label}样式', { label })}
        trigger={
          <button
            type="button"
            aria-label={tr('{label}样式', { label })}
            className="-ml-1 inline-flex h-8 w-4 items-center justify-center rounded-sm text-fg-subtle hover:bg-subtle hover:text-fg"
          >
            <ChevronDown size={12} strokeWidth={ICON_STROKE} aria-hidden />
          </button>
        }
      >
        {styles.map((k) => (
          <MenuItem
            key={k}
            checked={active && (current ?? (ordered ? 'decimal' : 'disc')) === k}
            onSelect={() => editor.chain().focus().setListStyle(k).run()}
          >
            {LIST_STYLES[k].label}
          </MenuItem>
        ))}
      </Menu>
    </span>
  );
}

// ---------------------------------------------------------------- 插入表格（网格）

const GRID = 8;

export function TableGridPicker({
  onPick,
  icon,
}: {
  onPick: (rows: number, cols: number) => void;
  icon: ReactNode;
}) {
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 3, c: 3 });
  return (
    <Popover
      label={tr('插入表格')}
      trigger={
        <IconButton size="sm" label={tr('插入表格')}>
          {icon}
        </IconButton>
      }
    >
      {(close) => (
        <div className="flex flex-col gap-2 p-1.5">
          <div
            className="grid gap-0.5"
            style={{ gridTemplateColumns: `repeat(${GRID}, 1.25rem)` }}
            onMouseLeave={() => setHover({ r: 3, c: 3 })}
          >
            {Array.from({ length: GRID * GRID }, (_, i) => {
              const r = Math.floor(i / GRID) + 1;
              const c = (i % GRID) + 1;
              const on = r <= hover.r && c <= hover.c;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={tr('{r} 行 {c} 列', { r, c })}
                  className={cn(
                    'size-5 rounded-xs border transition-colors duration-(--dur-instant)',
                    on ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
                  )}
                  onMouseEnter={() => setHover({ r, c })}
                  onFocus={() => setHover({ r, c })}
                  onClick={() => {
                    close();
                    onPick(r, c);
                  }}
                />
              );
            })}
          </div>
          <span className="text-center text-caption text-fg-muted tabular-nums">
            {tr('{r} × {c} 表格', { r: hover.r, c: hover.c })}
          </span>
        </div>
      )}
    </Popover>
  );
}
