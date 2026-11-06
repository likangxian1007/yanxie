/** Input / Textarea / Select 共用的外观（STYLE §6）。 */
export const fieldBase = [
  'w-full min-w-0 rounded-md border border-line-strong bg-surface text-fg shadow-xs',
  'placeholder:text-fg-subtle',
  'transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard)',
  'focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] focus-visible:outline-none',
  'aria-invalid:border-danger aria-invalid:focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--danger)_22%,transparent)]',
  'disabled:cursor-not-allowed disabled:bg-subtle disabled:text-fg-muted',
].join(' ');

export const fieldSize = {
  sm: 'h-7 px-2.5 text-small',
  md: 'h-8 px-3 text-body',
  lg: 'h-10 px-3.5 text-body',
} as const;

export type FieldSize = keyof typeof fieldSize;
