import { useId } from 'react';
import { Input, type InputProps } from '@/components/ui';

export interface FormFieldProps extends Omit<InputProps, 'id'> {
  label: string;
  hint?: string;
}

/** 标签 + 输入框（登录 / 注册用）。 */
export function FormField({ label, hint, ...props }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small font-medium text-fg">
        {label}
      </label>
      <Input id={id} size="lg" aria-describedby={hint ? hintId : undefined} {...props} />
      {hint && !props.error && (
        <p id={hintId} className="text-caption font-normal text-fg-subtle">
          {hint}
        </p>
      )}
    </div>
  );
}
