import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { renderIcon, type IconLike } from './icon';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: IconLike;
  /** Small count bubble. */
  count?: number;
}

export interface TabsProps<T extends string = string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accent color for the active indicator. */
  accent?: string;
  className?: string;
}

/** Underline tabs (scrollable on mobile). */
export function Tabs<T extends string>({ tabs, value, onChange, accent, className }: TabsProps<T>) {
  return (
    <div role="tablist" className={cn('-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1 scrollbar-none', className)}>
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={cn(
              'relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 pb-3 pt-2 text-sm font-semibold transition-colors',
              on ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {renderIcon(t.icon, undefined, 16)}
            {t.label}
            {t.count != null && (
              <span className={cn('rounded-full px-1.5 py-px text-[11px] tabular', on ? 'bg-primary-soft text-primary-soft-fg' : 'bg-surface-2 text-muted')}>
                {t.count}
              </span>
            )}
            <span
              className={cn('absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-opacity', on ? 'opacity-100' : 'opacity-0')}
              style={{ backgroundColor: accent ?? 'var(--primary)' }}
            />
          </button>
        );
      })}
    </div>
  );
}

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: IconLike;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  /** Stretch to full width with equal segments. */
  block?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** iOS-style segmented control with a sliding thumb. */
export function SegmentedControl<T extends string>({
  options, value, onChange, size = 'md', block, className, ...aria
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const index = options.findIndex((o) => o.value === value);

  useLayoutEffect(() => {
    const el = refs.current[index];
    if (!el) return setThumb(null);
    const update = () => setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, options.length]);

  return (
    <div
      role="radiogroup"
      aria-label={aria['aria-label']}
      className={cn('relative inline-flex rounded-xl bg-surface-2 p-1', block && 'flex w-full', className)}
    >
      {thumb && (
        <span
          aria-hidden
          className="absolute bottom-1 top-1 rounded-[10px] bg-surface shadow-[0_1px_3px_rgb(0_0_0/0.12)] transition-all duration-300 ease-[cubic-bezier(0.3,1.2,0.4,1)] dark:bg-surface-3"
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] font-semibold transition-colors',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3.5 text-[13px]',
              block && 'flex-1',
              on ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {renderIcon(o.icon, undefined, size === 'sm' ? 14 : 15)}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
