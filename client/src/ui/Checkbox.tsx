import { useId, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Custom checked color (e.g. a member color or module accent). */
  color?: string;
  /** 'circle' suits to-do items. */
  shape?: 'square' | 'circle';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  id?: string;
  'aria-label'?: string;
}

const boxSize = { sm: 'size-4', md: 'size-5', lg: 'size-6' };
const checkSize = { sm: 11, md: 13, lg: 15 };

export function Checkbox({
  checked, onChange, label, description, disabled, color, shape = 'square', size = 'md', className, id, ...aria
}: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label
      htmlFor={inputId}
      className={cn('group inline-flex items-start gap-3', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer', className)}
    >
      <span className="relative mt-px inline-flex shrink-0">
        <input
          id={inputId}
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={aria['aria-label']}
        />
        <span
          style={checked && color ? { backgroundColor: color, borderColor: color } : undefined}
          className={cn(
            boxSize[size],
            shape === 'circle' ? 'rounded-full' : 'rounded-md',
            'flex items-center justify-center border-2 transition-all duration-150',
            'peer-focus-visible:ring-4 peer-focus-visible:ring-ring',
            checked ? 'border-primary-solid bg-primary-solid text-white' : 'border-border-strong bg-surface group-hover:border-primary/60',
          )}
        >
          {checked && <Check size={checkSize[size]} strokeWidth={3.5} className="animate-check" />}
        </span>
      </span>
      {(label || description) && (
        <span className="flex min-w-0 flex-col">
          {label && <span className="text-sm font-medium leading-5 text-fg">{label}</span>}
          {description && <span className="text-xs text-muted">{description}</span>}
        </span>
      )}
    </label>
  );
}
