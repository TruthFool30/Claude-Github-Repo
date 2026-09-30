/** Tiny global store for app-shell UI state (search palette, more sheet, mobile bottom bar). */
import { useEffect, useSyncExternalStore } from 'react';

type ShellState = { searchOpen: boolean; moreOpen: boolean; hideBottomNav: boolean; toastPlacement: 'default' | 'top' };
let state: ShellState = { searchOpen: false, moreOpen: false, hideBottomNav: false, toastPlacement: 'default' };
const subs = new Set<() => void>();

export function setShell(patch: Partial<ShellState>) {
  state = { ...state, ...patch };
  subs.forEach((s) => s());
}

export const openSearch = () => setShell({ searchOpen: true, moreOpen: false });

export function useShell(): ShellState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => state,
  );
}

/**
 * Hide the mobile bottom tab bar while `active` (e.g. inside a full-screen chat on phones).
 * The shell also shrinks `--shell-chrome` and the bottom padding accordingly. Restored on unmount.
 * Has no effect on desktop (the bar is mobile-only).
 */
export function useHideBottomNav(active = true) {
  useEffect(() => {
    if (!active) return;
    setShell({ hideBottomNav: true });
    return () => setShell({ hideBottomNav: false });
  }, [active]);
}

/**
 * Show toasts centred at the top (below the header) while `active` — for full-screen modes whose
 * primary buttons sit at the bottom (e.g. cook mode). Restored on unmount.
 */
export function useToastPlacement(placement: 'default' | 'top', active = true) {
  useEffect(() => {
    if (!active || placement === 'default') return;
    setShell({ toastPlacement: placement });
    return () => setShell({ toastPlacement: 'default' });
  }, [placement, active]);
}
