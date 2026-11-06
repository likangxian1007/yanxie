import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { fieldBase, fieldSize, type FieldSize } from './field-styles';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: FieldSize;
  /** 错误文案：描边变 danger，下方显示 12px 红字 */
  error?: string | undefined;
  /** 输入框内左侧的图标（16px） */
  leading?: ReactNode;
  /** 输入框内右侧的内容（按钮、Kbd 等） */
  trailing?: ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    error,
    leading,
    trailing,
    wrapperClassName,
    className,
    id,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    ...props
  },
  ref,
) {
  const autoId = useId();
  const errorId = `${id ?? autoId}-error`;
  const invalid = Boolean(error) || ariaInvalid === true || ariaInvalid === 'true';

  return (
    <div className={cn('w-full', wrapperClassName)}>
      <div className="relative flex items-center">
        {leading && (
          <span className="pointer-events-none absolute left-2.5 flex text-fg-subtle [&_svg]:size-4">
            {leading}
          </span>
        )}
        <input
          ref={ref}
          id={id}
          aria-invalid={invalid || undefined}
          aria-describedby={cn(describedBy, error && errorId) || undefined}
          className={cn(
            fieldBase,
            fieldSize[size],
            leading && 'pl-8',
            trailing && 'pr-9',
            className,
          )}
          {...props}
        />
        {trailing && <span className="absolute right-1.5 flex items-center">{trailing}</span>}
      </div>
      {error && (
        <p id={errorId} className="mt-1.5 text-caption font-normal text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
