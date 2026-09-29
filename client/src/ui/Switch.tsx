import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** iOS-style toggle. With a label it renders as a full-width settings row. */
export function Switch({ checked, onChange, label, description, disabled, className, ...aria }: SwitchProps) {
  const id = useId();
  const toggle = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label']}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-surface-3',
      )}
    >
      <span
        className={cn(
          'size-6 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-[cubic-bezier(0.3,1.4,0.5,1)]',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
  if (!label) return <span className={className}>{toggle}</span>;
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col">
        <span className="text-sm font-medium text-fg">{label}</span>
        {description && <span className="text-xs text-muted">{description}</span>}
      </label>
      {toggle}
    </div>
  );
}
