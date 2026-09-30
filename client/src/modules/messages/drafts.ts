// Unsent message drafts: a module-level store mirrored to localStorage, keyed by
// user + family + conversation, so drafts survive stacked navigation, leaving the page and reloads.
import { useSyncExternalStore } from 'react';

const PREFIX = 'hearth-msg-draft:';
const mem = new Map<string, string>();
const subs = new Set<() => void>();
let version = 0;

const keyOf = (userId: number, familyId: number, convId: number) => `${PREFIX}${userId}:${familyId}:${convId}`;

export function getDraft(userId: number, familyId: number, convId: number): string {
  const k = keyOf(userId, familyId, convId);
  if (mem.has(k)) return mem.get(k)!;
  let v = '';
  try {
    v = localStorage.getItem(k) ?? '';
  } catch {
    /* storage unavailable */
  }
  mem.set(k, v);
  return v;
}

export function setDraft(userId: number, familyId: number, convId: number, text: string) {
  const k = keyOf(userId, familyId, convId);
  const v = text.trim() ? text : '';
  if ((mem.get(k) ?? '') === v) return;
  mem.set(k, v);
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage unavailable — keep in memory */
  }
  version++;
  subs.forEach((s) => s());
}

/** Re-renders when any draft changes; read values with getDraft. */
export function useDraftsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => version,
    () => version,
  );
}
