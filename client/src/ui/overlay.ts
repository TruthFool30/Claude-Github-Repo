/** Shared helpers for overlays (Modal, Lightbox, SearchPalette…): stacking, scroll lock, focus trap. */
import { useCallback, useEffect, useRef, useState } from 'react';

const stack: symbol[] = [];
let lockCount = 0;
let savedOverflow = '';
let savedPadding = '';

/** Registers an open overlay; returns a STABLE function telling whether it is the topmost one. */
export function useOverlayStack(active: boolean) {
  const idRef = useRef<symbol>(Symbol('overlay'));
  useEffect(() => {
    if (!active) return;
    const id = idRef.current;
    stack.push(id);
    return () => {
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
  return useCallback(() => stack[stack.length - 1] === idRef.current, []);
}

/** Lock body scroll while active (ref-counted, compensates scrollbar width). */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) {
      const sbw = window.innerWidth - document.documentElement.clientWidth;
      savedOverflow = document.body.style.overflow;
      savedPadding = document.body.style.paddingRight;
      document.body.style.overflow = 'hidden';
      if (sbw > 0) document.body.style.paddingRight = `${sbw}px`;
    }
    lockCount++;
    return () => {
      lockCount--;
      if (lockCount === 0) {
        document.body.style.overflow = savedOverflow;
        document.body.style.paddingRight = savedPadding;
      }
    };
  }, [active]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('data-focus-skip') && el.offsetParent !== null,
  );
}

/**
 * Trap Tab focus inside `ref` while active, focus the first field (or `[data-autofocus]`) on open,
 * and restore focus to the previously focused element on close.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean, isTop?: () => boolean) {
  // Keep the latest isTop in a ref so the effect below only re-runs when `active` changes —
  // re-running it would steal focus back to the first field on every parent re-render.
  const isTopRef = useRef(isTop);
  isTopRef.current = isTop;
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const preferred = root.querySelector<HTMLElement>('[data-autofocus]');
      const firstField = root.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
      const target = preferred ?? (window.matchMedia('(pointer: fine)').matches ? firstField : null) ?? root;
      target.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !(isTopRef.current?.() ?? true)) return;
      const root = ref.current;
      if (!root) return;
      const items = focusableIn(root);
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

/**
 * Keep an element mounted while its exit animation plays.
 * Returns { mounted, closing }.
 */
export function usePresence(open: boolean, exitMs = 220) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, exitMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return { mounted, closing };
}

/** Escape key handler that only fires for the topmost overlay. */
export function useEscape(active: boolean, isTop: () => boolean, onEscape: () => void) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  const isTopRef = useRef(isTop);
  isTopRef.current = isTop;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopRef.current()) {
        e.stopPropagation();
        cb.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}
