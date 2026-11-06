import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { fieldBase } from './field-styles';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string | undefined;
  /** 跟随内容自动增高（最高 40vh）；不支持 field-sizing 的浏览器退化为固定行数 */
  autoGrow?: boolean;
  wrapperClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    error,
    autoGrow,
    wrapperClassName,
    className,
    id,
    rows = 3,
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
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        aria-invalid={invalid || undefined}
        aria-describedby={cn(describedBy, error && errorId) || undefined}
        className={cn(
          fieldBase,
          'min-h-16 resize-y px-3 py-2 text-body',
          autoGrow && 'field-sizing-content max-h-[40vh] resize-none',
          className,
        )}
        {...props}
      />
      {error && (
        <p id={errorId} className="mt-1.5 text-caption font-normal text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
