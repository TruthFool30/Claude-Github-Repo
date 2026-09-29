import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '../lib/cn';
import { renderIcon, type IconLike } from './icon';
import { Spinner } from './Spinner';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconLike;
  /** Required accessible label (also used as tooltip). */
  label: string;
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger' | 'soft';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  /** Small dot badge (e.g. unread). `true` or a number. */
  badge?: boolean | number;
  ref?: Ref<HTMLButtonElement>;
}

const variants = {
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  secondary: 'bg-surface border border-border text-fg hover:bg-surface-2 shadow-xs',
  primary: 'bg-primary-solid text-on-primary hover:bg-primary-solid-hover shadow-xs',
  danger: 'text-danger hover:bg-danger-soft',
  soft: 'bg-primary-soft text-primary-soft-fg hover:brightness-95 dark:hover:brightness-125',
};
const sizes = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-12 rounded-2xl' };
const iconSizes = { sm: 16, md: 19, lg: 22 };

export function IconButton({
  icon, label, variant = 'ghost', size = 'md', loading, badge, className, type = 'button', disabled, ref, ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center transition-all duration-150 active:scale-90',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSizes[size] - 2} /> : renderIcon(icon, undefined, iconSizes[size])}
      {badge ? (
        typeof badge === 'number' ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger-solid px-1 text-[10px] font-bold leading-none text-white ring-2 ring-surface tabular">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : (
          <span className="absolute right-2 top-2 size-2 rounded-full bg-danger-solid ring-2 ring-surface" />
        )
      ) : null}
    </button>
  );
}
