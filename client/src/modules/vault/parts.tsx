import { useEffect, useRef, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Input } from '../../ui';
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
