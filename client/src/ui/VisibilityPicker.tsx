// "Who can see it" — Everyone / Adults only / Only me. Shared by the vault and the budget.
import { useRef } from 'react';
import { Lock, ShieldCheck, Users, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { SegmentedControl, radioKeys } from './Tabs';

export type Visibility = 'family' | 'adults' | 'private';

export const VISIBILITY: Record<Visibility, { label: string; short: string; icon: LucideIcon; hint: string }> = {
  family: { label: 'Everyone', short: 'Family', icon: Users, hint: 'Everyone in the family can see it' },
  adults: { label: 'Adults only', short: 'Adults', icon: ShieldCheck, hint: 'Hidden from children' },
  private: { label: 'Only me', short: 'Only me', icon: Lock, hint: 'Nobody else can see or find it' },
};

export interface VisibilityPickerProps<V extends Visibility> {
  value: V;
  onChange: (v: V) => void;
  /** Choices in order (default: all three). */
  options?: readonly V[];
  /** false drops "Adults only" (children couldn't see it themselves). */
  allowAdults?: boolean;
  disabled?: boolean;
  /** "Who can see {what}" */
  what?: string;
  /** Full-width rows with hints (default: a compact segmented control + hint line). */
  stacked?: boolean;
}

export function VisibilityPicker<V extends Visibility>({
  value, onChange, options: given = Object.keys(VISIBILITY) as V[], allowAdults = true, disabled, what = 'it', stacked,
}: VisibilityPickerProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const options = allowAdults ? given : given.filter((v) => v !== 'adults');
  const label = `Who can see ${what}`;
  if (!stacked) {
    return (
      <div className={cn('flex flex-col gap-2', disabled && 'pointer-events-none opacity-60')}>
        <span className="text-[13px] font-semibold text-fg" aria-hidden>{label}</span>
        <SegmentedControl<V>
          aria-label={label}
          block
          value={value}
          onChange={onChange}
          options={options.map((v) => ({ value: v, label: VISIBILITY[v].short, icon: VISIBILITY[v].icon }))}
        />
        <p className="text-xs text-muted">{VISIBILITY[value].hint}</p>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-1.5', disabled && 'pointer-events-none opacity-60')}>
      <span className="text-[13px] font-semibold text-fg" aria-hidden>{label}</span>
      <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className="flex flex-col gap-1" onKeyDown={radioKeys(options, value, onChange, refs.current)}>
        {options.map((v, i) => {
          const V = VISIBILITY[v];
          const on = v === value;
          return (
            <button
              key={v}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(v)}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                on ? 'border-primary bg-primary-soft/60' : 'border-border hover:bg-surface-2',
              )}
            >
              <V.icon size={17} className={on ? 'text-primary' : 'text-muted'} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-fg">{V.label}</span>
                <span className="block text-xs text-muted">{V.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Small marker for restricted items (nothing for family-visible ones). */
export function VisibilityBadge({ value, className, iconOnly }: { value: Visibility | null | undefined; className?: string; iconOnly?: boolean }) {
  if (!value || value === 'family') return null;
  const V = VISIBILITY[value];
  const tone = value === 'private' ? 'bg-warning-soft text-warning-soft-fg' : 'bg-info-soft text-info-soft-fg';
  if (iconOnly) {
    return (
      <span title={V.label} className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full', tone, className)}>
        <V.icon size={11} aria-hidden />
        <span className="sr-only">{V.label}</span>
      </span>
    );
  }
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', tone, className)}>
      <V.icon size={10} aria-hidden /> {V.label}
    </span>
  );
}
