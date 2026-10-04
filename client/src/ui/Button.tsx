import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../lib/cn';
import { renderIcon, type IconLike } from './icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-semibold transition-all duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97]';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary-solid text-on-primary shadow-xs hover:bg-primary-solid-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]',
  secondary: 'bg-surface text-fg border border-border shadow-xs hover:bg-surface-2 hover:border-border-strong',
  outline: 'bg-transparent text-fg border border-border-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-muted hover:bg-surface-2 hover:text-fg',
  soft: 'bg-primary-soft text-primary-soft-fg hover:brightness-95 dark:hover:brightness-125',
  danger: 'bg-danger-solid text-white shadow-xs hover:bg-danger-solid-hover',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 rounded-lg px-3 text-[13px]',
  md: 'h-10 rounded-xl px-4 text-sm',
  lg: 'h-12 rounded-xl px-5 text-[15px]',
};

const iconSizes: Record<ButtonSize, number> = { sm: 15, md: 17, lg: 18 };

/** Class string for styling links/other elements like a Button. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra?: string) {
  return cn(base, variants[variant], sizes[size], extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Leading icon: a lucide component (`icon={Plus}`) or element. */
  icon?: IconLike;
  /** Trailing icon. */
  iconRight?: IconLike;
  /** Full width. */
  block?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  block,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  const iconSize = iconSizes[size];
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, cn(block && 'w-full', className))}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} className="shrink-0" /> : renderIcon(icon, 'shrink-0', iconSize)}
      {children}
      {!loading && renderIcon(iconRight, 'shrink-0', iconSize)}
    </button>
  );
}
