import { useEffect, useRef, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Input, SegmentedControl } from '../../ui';
import { Lock, ShieldCheck, Users } from 'lucide-react';
import type { Visibility } from './api';
import type { LucideIcon } from 'lucide-react';

/** Search input with a clear button; "/" focuses it from anywhere on the page. */
export function SearchField({ value, onChange, placeholder, label, className }: {
  value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Input
      ref={ref}
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && value) {
          e.stopPropagation();
          onChange('');
        }
      }}
      placeholder={placeholder}
      aria-label={label}
      icon={Search}
      className={cn('[&_input::-webkit-search-cancel-button]:hidden', className)}
      trailing={
        value ? (
          <button
            type="button"
            onClick={() => {
              onChange('');
              ref.current?.focus();
            }}
            aria-label="Clear search"
            className="inline-flex size-8 items-center justify-center rounded-lg text-subtle transition hover:bg-surface-2 hover:text-fg"
          >
            <X size={16} />
          </button>
        ) : (
          <kbd className="mr-1.5 hidden rounded-md border border-border px-1.5 py-0.5 text-[11px] font-semibold text-subtle sm:inline">/</kbd>
        )
      }
    />
  );
}

/** Toggle chip for filters (horizontal scroll rows). */
export function Chip({ active, onClick, icon: Icon, color, count, children }: {
  active: boolean; onClick: () => void; icon?: LucideIcon; color?: string; count?: number; children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold transition-all duration-150 active:scale-95',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
        active ? 'border-transparent bg-fg text-bg shadow-xs' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-fg',
      )}
    >
      {Icon && <Icon size={15} style={!active && color ? { color } : undefined} aria-hidden />}
      {children}
      {count !== undefined && <span className={cn('tabular text-[11px]', active ? 'opacity-70' : 'text-subtle')}>{count}</span>}
    </button>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center justify-between gap-3', className)}>
      <h2 className="text-[13px] font-bold uppercase tracking-wider text-subtle">{children}</h2>
      {action}
    </div>
  );
}

export const VISIBILITY: Record<Visibility, { label: string; short: string; icon: LucideIcon; hint: string }> = {
  family: { label: 'Everyone', short: 'Family', icon: Users, hint: 'Everyone in the family can see it' },
  adults: { label: 'Adults only', short: 'Adults', icon: ShieldCheck, hint: 'Hidden from children' },
  private: { label: 'Only me', short: 'Only me', icon: Lock, hint: 'Nobody else can see or find it' },
};

/** Who can see a document / info card. Children can't pick "Adults only" (they couldn't see it). */
export function VisibilityPicker({ value, onChange, allowAdults, disabled, what = 'it', stacked }: {
  value: Visibility; onChange: (v: Visibility) => void; allowAdults: boolean; disabled?: boolean; what?: string; stacked?: boolean;
}) {
  const opts = (Object.keys(VISIBILITY) as Visibility[]).filter((v) => allowAdults || v !== 'adults');
  if (stacked) {
    return (
      <div className={cn('flex flex-col gap-1.5', disabled && 'pointer-events-none opacity-60')}>
        <span className="text-[13px] font-semibold text-fg">Who can see {what}</span>
        <div role="radiogroup" aria-label={`Who can see ${what}`} className="flex flex-col gap-1">
          {opts.map((v) => {
            const V = VISIBILITY[v];
            const on = v === value;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(v)}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                  on ? 'border-primary bg-primary-soft/60' : 'border-transparent hover:bg-surface-2',
                )}
              >
                <V.icon size={16} className={on ? 'text-primary' : 'text-muted'} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-fg">{V.label}</span>
                  <span className="block text-[11px] text-muted">{V.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-2', disabled && 'pointer-events-none opacity-60')}>
      <span className="text-[13px] font-semibold text-fg" id="vault-vis-label">Who can see {what}</span>
      <SegmentedControl<Visibility>
        aria-label={`Who can see ${what}`}
        block
        value={value}
        onChange={onChange}
        options={opts.map((v) => ({ value: v, label: VISIBILITY[v].short, icon: VISIBILITY[v].icon }))}
      />
      <p className="text-xs text-muted">{VISIBILITY[value].hint}</p>
    </div>
  );
}

/** Small marker for restricted items. */
export function VisibilityBadge({ value, className, iconOnly }: { value: Visibility; className?: string; iconOnly?: boolean }) {
  if (value === 'family') return null;
  const V = VISIBILITY[value];
  if (iconOnly) {
    return (
      <span title={V.label} className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full', value === 'private' ? 'bg-warning-soft text-warning-soft-fg' : 'bg-info-soft text-info-soft-fg', className)}>
        <V.icon size={11} aria-hidden />
        <span className="sr-only">{V.label}</span>
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', value === 'private' ? 'bg-warning-soft text-warning-soft-fg' : 'bg-info-soft text-info-soft-fg', className)}>
      <V.icon size={10} aria-hidden /> {V.label}
    </span>
  );
}
