import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fieldBase, fieldSize, type FieldSize } from './field-styles';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: FieldSize;
  options?: SelectOption[];
  error?: string | undefined;
  wrapperClassName?: string;
  children?: ReactNode;
}

/** 原生 select 套上 Input 外观（键盘、读屏、移动端滚轮都是原生的）。 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', options, error, wrapperClassName, className, children, ...props },
  ref,
) {
  return (
    <div className={cn('w-full', wrapperClassName)}>
      <div className="relative flex items-center">
        <select
          ref={ref}
          aria-invalid={error ? true : undefined}
          className={cn(
            fieldBase,
            fieldSize[size],
            'cursor-pointer appearance-none pr-8',
            className,
          )}
          {...props}
        >
          {options?.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
          {children}
        </select>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className="pointer-events-none absolute right-2.5 text-fg-subtle"
        />
      </div>
      {error && <p className="mt-1.5 text-caption font-normal text-danger">{error}</p>}
    </div>
  );
});
