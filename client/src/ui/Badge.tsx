import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  /** Custom hex color (overrides tone), e.g. a member or category color. */
  color?: string;
  /** Leading dot. */
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  children: ReactNode;
}

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary-soft-fg',
  success: 'bg-success-soft text-success-soft-fg',
  warning: 'bg-warning-soft text-warning-soft-fg',
  danger: 'bg-danger-soft text-danger-soft-fg',
  info: 'bg-info-soft text-info-soft-fg',
};

export function Badge({ tone = 'neutral', color, dot, size = 'sm', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        !color && tones[tone],
        className,
      )}
      style={color ? { backgroundColor: `color-mix(in oklab, ${color} 15%, transparent)`, color: `color-mix(in oklab, ${color} 55%, var(--fg))` } : undefined}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
