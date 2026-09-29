/** Tiny global store for app-shell UI state (search palette, more sheet). */
import { useSyncExternalStore } from 'react';

type ShellState = { searchOpen: boolean; moreOpen: boolean };
let state: ShellState = { searchOpen: false, moreOpen: false };
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
