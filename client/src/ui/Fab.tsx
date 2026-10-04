import type { ButtonHTMLAttributes } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '../lib/cn';
import { renderIcon, type IconLike } from './icon';

export interface FabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible label (and visible text when `extended`). */
  label: string;
  icon?: IconLike;
  /** Background color (module accent). Defaults to primary. */
  accent?: string;
  /** Show the label next to the icon. */
  extended?: boolean;
  /** Also show on desktop (default: mobile only). */
  desktop?: boolean;
}

/** Floating add button, sits above the mobile bottom nav. */
export function Fab({ label, icon = Plus, accent, extended, desktop, className, style, ...rest }: FabProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={{ backgroundColor: accent, ...style }}
      className={cn(
        'fixed right-4 z-30 inline-flex items-center justify-center gap-2 rounded-2xl bg-primary-solid font-semibold text-white shadow-lift',
        'bottom-[calc(80px+env(safe-area-inset-bottom))] lg:bottom-8 lg:right-8',
        'transition-all duration-200 hover:brightness-110 active:scale-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
        'shadow-[0_8px_24px_-6px_rgb(0_0_0/0.35)] animate-scale-in',
        extended ? 'h-14 pl-4 pr-5 text-[15px]' : 'size-14',
        !desktop && 'lg:hidden',
        className,
      )}
      {...rest}
    >
      {renderIcon(icon, undefined, 24)}
      {extended && <span>{label}</span>}
    </button>
  );
}
