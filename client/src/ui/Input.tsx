import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { useFieldControl } from './Field';
import { renderIcon, type IconLike } from './icon';

export const controlClass =
  'w-full rounded-xl border border-border bg-surface text-fg placeholder:text-subtle shadow-xs transition-[border-color,box-shadow] duration-150 ' +
  'hover:border-border-strong focus:border-primary focus:outline-none focus:ring-4 focus:ring-ring/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25';

const sizeClass = { sm: 'h-9 text-[13px] px-3', md: 'h-11 text-[15px] sm:text-sm px-3.5', lg: 'h-12 text-base px-4' };

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Leading icon inside the field. */
  icon?: IconLike;
  /** Trailing element inside the field (e.g. a button or unit). */
  trailing?: ReactNode;
  invalid?: boolean;
  size?: 'sm' | 'md' | 'lg';
  ref?: Ref<HTMLInputElement>;
}

export function Input({ icon, trailing, invalid, size = 'md', className, id, ref, ...rest }: InputProps) {
  const field = useFieldControl();
  const input = (
    <input
      ref={ref}
      id={id ?? field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={invalid || field?.invalid || undefined}
      className={cn(controlClass, sizeClass[size], !!icon && 'pl-10', !!trailing && 'pr-11', !icon && !trailing && className)}
      {...rest}
    />
  );
  if (!icon && !trailing) return input;
  return (
    <div className={cn('relative', className)}>
      {icon && (
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle">{renderIcon(icon, undefined, 17)}</span>
      )}
      {input}
      {trailing && <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">{trailing}</span>}
    </div>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Grow with content up to maxRows (default: fixed rows). */
  autoGrow?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ invalid, className, id, rows = 3, autoGrow, onInput, ref, ...rest }: TextareaProps) {
  const field = useFieldControl();
  return (
    <textarea
      ref={ref}
      id={id ?? field?.id}
      rows={rows}
      aria-describedby={field?.describedBy}
      aria-invalid={invalid || field?.invalid || undefined}
      onInput={(e) => {
        if (autoGrow) {
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
        }
        onInput?.(e);
      }}
      className={cn(controlClass, 'resize-none px-3.5 py-2.5 text-[15px] leading-relaxed sm:text-sm', className)}
      {...rest}
    />
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  invalid?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Convenience: options instead of children. */
  options?: Array<{ value: string | number; label: string; disabled?: boolean }>;
  placeholder?: string;
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ invalid, size = 'md', className, id, options, placeholder, children, ref, ...rest }: SelectProps) {
  const field = useFieldControl();
  return (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        id={id ?? field?.id}
        aria-describedby={field?.describedBy}
        aria-invalid={invalid || field?.invalid || undefined}
        className={cn(controlClass, sizeClass[size], 'appearance-none pr-10')}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
    </div>
  );
}
