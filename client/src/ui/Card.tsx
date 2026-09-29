import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../lib/cn';
import { renderIcon, type IconLike } from './icon';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Hover lift + pointer (for clickable cards). */
  interactive?: boolean;
  ref?: Ref<HTMLDivElement>;
}

const pad = { none: '', sm: 'p-3', md: 'p-4 sm:p-5', lg: 'p-5 sm:p-7' };

/** White/elevated surface with subtle border, rounded-2xl and soft shadow. */
export function Card({ padding = 'md', interactive, className, ref, ...rest }: CardProps) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-border bg-surface shadow-card',
        pad[padding],
        interactive &&
          'cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift active:translate-y-0',
        className,
      )}
      {...rest}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconLike;
  /** Accent color for the icon tile. */
  accent?: string;
  action?: ReactNode;
  className?: string;
}

/** Title row for a Card: optional tinted icon tile, title/subtitle and a right-side action. */
export function CardHeader({ title, subtitle, icon, accent, action, className }: CardHeaderProps) {
  return (
    <div className={cn('mb-4 flex items-center gap-3', className)}>
      {icon && (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"
          style={accent ? { backgroundColor: `${accent}1f`, color: accent } : undefined}
        >
          {renderIcon(icon, undefined, 18)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold tracking-tight text-fg">{title}</h3>
        {subtitle && <p className="truncate text-[13px] text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
