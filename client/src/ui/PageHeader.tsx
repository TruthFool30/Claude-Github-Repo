import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { useDocumentTitle } from '../lib/hooks';
import { renderIcon, type IconLike } from './icon';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Icon shown in a tinted tile before the title. */
  icon?: IconLike;
  /** Module accent color (tints the icon tile). */
  accent?: string;
  /** Right-aligned actions (buttons, menus). Wrap on small screens. */
  actions?: ReactNode;
  /** Show a back button: a path, or `true` for history back. */
  back?: string | boolean;
  /** Extra content under the title row (tabs, filters…). */
  children?: ReactNode;
  className?: string;
  /** Sets document.title; defaults to `title` when it is a string. */
  documentTitle?: string;
}

/** Page title block used at the top of every page. */
export function PageHeader({ title, subtitle, icon, accent, actions, back, children, className, documentTitle }: PageHeaderProps) {
  const navigate = useNavigate();
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : null));
  return (
    <header className={cn('mb-5 sm:mb-7', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-[12rem] flex-1 items-center gap-3">
          {back && (
            <button
              type="button"
              aria-label="Back"
              onClick={() => (typeof back === 'string' ? navigate(back) : navigate(-1))}
              className="-ml-2 inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg"
            >
              <ArrowLeft size={20} />
            </button>
          )}
          {icon && (
            <div
              className="hidden size-11 shrink-0 items-center justify-center rounded-2xl sm:flex"
              style={{
                backgroundColor: `color-mix(in oklab, ${accent ?? 'var(--primary)'} 14%, transparent)`,
                color: accent ?? 'var(--primary)',
              }}
            >
              {renderIcon(icon, undefined, 22)}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-[26px] font-bold leading-tight tracking-tight text-fg sm:text-[28px]">{title}</h1>
            {subtitle && <p className="mt-0.5 truncate text-sm text-muted sm:text-[15px]">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}
