import { forwardRef, type HTMLAttributes } from 'react';
import { BrandSymbol } from './BrandSymbol';
import { cn } from '@/lib/cn';
import { initials, paletteFromString, paletteVar } from '@/lib/palette';

export type AvatarKind = 'user' | 'agent' | 'coordinator';
export type AvatarSize = 20 | 24 | 32 | 40;

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  name: string;
  /** 色板序号 0–7；不传时按名字稳定取色 */
  color?: number | undefined;
  kind?: AvatarKind;
  size?: AvatarSize;
  src?: string | null | undefined;
  /** 堆叠时的 2px canvas 外圈 */
  ring?: boolean;
}

const SIZE: Record<AvatarSize, { box: string; text: string; icon: number }> = {
  20: { box: 'size-5', text: 'text-[0.625rem]', icon: 11 },
  24: { box: 'size-6', text: 'text-[0.6875rem]', icon: 13 },
  32: { box: 'size-8', text: 'text-small', icon: 16 },
  40: { box: 'size-10', text: 'text-h3', icon: 20 },
};

/**
 * 头像：人类使用原有色板；协调者与个人、线程智能体统一使用研协日月圆印。
 */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, color, kind = 'user', size = 24, src, ring, className, style, ...props },
  ref,
) {
  const s = SIZE[size];
  const isAgent = kind !== 'user';
  const background = isAgent ? undefined : paletteVar(color ?? paletteFromString(name));

  return (
    <span
      ref={ref}
      role="img"
      aria-label={name}
      title={name}
      data-kind={kind}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-accent-fg select-none',
        s.box,
        s.text,
        isAgent && 'bg-surface text-accent',
        ring && 'ring-2 ring-canvas',
        className,
      )}
      style={{ backgroundColor: background, ...style }}
      {...props}
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" draggable={false} />
      ) : isAgent ? (
        <BrandSymbol className="size-full" />
      ) : (
        <span aria-hidden className="leading-none">
          {initials(name)}
        </span>
      )}
    </span>
  );
});
