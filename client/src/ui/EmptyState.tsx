import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { renderIcon, type IconLike } from './icon';

export interface EmptyStateProps {
  icon?: IconLike;
  title: ReactNode;
  description?: ReactNode;
  /** CTA, e.g. <Button icon={Plus}>Add event</Button> */
  action?: ReactNode;
  /** Tint for the illustration (defaults to primary). */
  accent?: string;
  /** Smaller variant for use inside cards. */
  compact?: boolean;
  /** Heading level for the title (default h3; use 'h1' when the empty state is the whole page). */
  as?: 'h1' | 'h2' | 'h3';
  className?: string;
}

/** Friendly empty state with an illustration-like icon badge. */
export function EmptyState({ icon, title, description, action, accent, compact, as: Heading = 'h3', className }: EmptyStateProps) {
  const color = accent ?? 'var(--primary)';
  const size = compact ? 56 : 88;
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : 'px-6 py-14 sm:py-20', className)}>
      {icon && (
        <div className="relative mb-5" style={{ width: size + 28, height: size + 28 }} aria-hidden>
          <div
            className="absolute inset-0 rounded-full opacity-60"
            style={{ background: `radial-gradient(circle, color-mix(in oklab, ${color} 18%, transparent) 0%, transparent 70%)` }}
          />
          <div
            className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 rotate-[-6deg] items-center justify-center rounded-[28%] shadow-lift"
            style={{
              width: size,
              height: size,
              background: `linear-gradient(145deg, color-mix(in oklab, ${color} 16%, var(--surface)), color-mix(in oklab, ${color} 30%, var(--surface)))`,
              color,
              border: `1px solid color-mix(in oklab, ${color} 22%, transparent)`,
            }}
          >
            {renderIcon(icon, undefined, compact ? 26 : 40)}
          </div>
          <span className="absolute right-1 top-3 size-2.5 rounded-full opacity-70" style={{ backgroundColor: color }} />
          <span className="absolute bottom-4 left-0 size-1.5 rounded-full opacity-50" style={{ backgroundColor: color }} />
        </div>
      )}
      <Heading className={cn('font-bold tracking-tight text-fg', compact ? 'text-base' : 'text-xl')}>{title}</Heading>
      {description && <p className={cn('mt-1.5 max-w-sm text-muted', compact ? 'text-[13px]' : 'text-[15px] leading-relaxed')}>{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
