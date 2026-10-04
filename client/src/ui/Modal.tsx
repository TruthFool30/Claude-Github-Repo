import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { useMediaQuery } from '../lib/hooks';
import { useEscape, useFocusTrap, useOverlayStack, usePresence, useScrollLock } from './overlay';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Action row pinned to the bottom (buttons stretch on mobile). */
  footer?: ReactNode;
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Hide the X button. */
  hideClose?: boolean;
  /** Prevent closing via backdrop / Esc / swipe (e.g. while saving). */
  dismissible?: boolean;
  /** Icon shown before the title (e.g. module icon). */
  icon?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };

/**
 * Dialog: centered card on ≥640px, draggable bottom sheet on phones.
 * Animated in/out, focus-trapped, closes on Esc/backdrop, restores focus.
 * Wrap form content in <form> yourself if you want Enter-to-submit; the footer can hold submit buttons with form="id".
 */
export function Modal({
  open, onClose, title, description, footer, children, size = 'md', hideClose, dismissible = true, icon, className, bodyClassName,
}: ModalProps) {
  const { mounted, closing } = usePresence(open, 240);
  const isTop = useOverlayStack(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const isSheet = !useMediaQuery('(min-width: 640px)');
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<{ y: number; t: number } | null>(null);

  useScrollLock(open);
  useFocusTrap(panelRef, open, isTop);
  useEscape(open, isTop, () => dismissible && onClose());

  if (!mounted) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!isSheet || !dismissible) return;
    dragStart.current = { y: e.clientY, t: Date.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    setDrag(Math.max(0, e.clientY - dragStart.current.y));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dy = e.clientY - dragStart.current.y;
    const velocity = dy / Math.max(1, Date.now() - dragStart.current.t);
    dragStart.current = null;
    if (dy > 120 || velocity > 0.6) onClose();
    else setDrag(0);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="presentation">
      <div
        className={cn('absolute inset-0 bg-overlay backdrop-blur-[3px]', closing ? 'animate-fade-out' : 'animate-fade-in')}
        onClick={() => dismissible && onClose()}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        style={isSheet ? ({ transform: drag ? `translateY(${drag}px)` : undefined, '--sheet-drag': `${drag}px` } as React.CSSProperties) : undefined}
        className={cn(
          'relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface shadow-pop outline-none',
          'rounded-t-[28px] border-t border-border sm:max-h-[85vh] sm:rounded-3xl sm:border',
          widths[size],
          isSheet ? (closing ? 'animate-sheet-out' : drag ? '' : 'animate-sheet-in') : closing ? 'animate-scale-out' : 'animate-scale-in',
          className,
        )}
      >
        {isSheet && (
          <div
            className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            aria-hidden
          >
            <span className="h-1.5 w-10 rounded-full bg-border-strong" />
          </div>
        )}
        {(title || !hideClose) && (
          <div
            className={cn('flex shrink-0 items-start gap-3 px-5 sm:px-6', isSheet ? 'pt-1.5' : 'pt-5', title ? 'pb-3' : 'pb-0')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id={titleId} className="text-lg font-bold leading-snug tracking-tight text-fg">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              )}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Close"
                className="-mr-2 -mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
              >
                <X size={19} />
              </button>
            )}
          </div>
        )}
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 scrollbar-thin sm:px-6 sm:pb-6', !footer && 'pb-[max(1.25rem,env(safe-area-inset-bottom))]', bodyClassName)}>
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:px-6 [&>*]:flex-1 sm:[&>*]:flex-none">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
