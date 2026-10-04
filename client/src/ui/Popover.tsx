import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import { useEscape, useOverlayStack, usePresence } from './overlay';

export interface PopoverProps {
  open: boolean;
  /** Called with 'escape' (Esc key) or 'outside' (click/tap elsewhere, resize). */
  onClose: (reason: 'escape' | 'outside') => void;
  /** Element the popover is positioned against. */
  anchorRef: RefObject<HTMLElement | null>;
  align?: 'start' | 'end';
  /** Gap from the anchor (px). */
  offset?: number;
  className?: string;
  children: ReactNode;
  role?: string;
  id?: string;
  'aria-label'?: string;
}

/**
 * Floating panel anchored to an element (flips above when there's no room below, clamps to the
 * viewport). Closes on outside click, Esc, resize. Used by Menu and the notification panel.
 */
export function Popover({ open, onClose, anchorRef, align = 'end', offset = 8, className, children, ...rest }: PopoverProps) {
  const { mounted, closing } = usePresence(open, 140);
  const isTop = useOverlayStack(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);

  useEscape(open, isTop, () => onClose('escape'));

  useLayoutEffect(() => {
    if (!mounted) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = panelRef.current;
      if (!a || !p) return;
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = align === 'end' ? a.right - w : a.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      let top = a.bottom + offset;
      let origin = 'top';
      if (top + h > vh - 8 && a.top - offset - h > 8) {
        top = a.top - offset - h;
        origin = 'bottom';
      }
      setPos({ top, left, origin: `${origin} ${align === 'end' ? 'right' : 'left'}` });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [mounted, anchorRef, align, offset]);

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose('outside');
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, onClose, anchorRef]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={panelRef}
      {...rest}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, transformOrigin: pos?.origin }}
      className={cn(
        'fixed z-[60] rounded-2xl border border-border bg-surface shadow-pop outline-none',
        closing ? 'animate-fade-out' : pos ? 'animate-pop-in' : 'opacity-0',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
