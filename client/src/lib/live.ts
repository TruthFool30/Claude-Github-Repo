/**
 * Realtime (SSE) client. One shared EventSource for the whole app, opened by the
 * AuthProvider once signed in, with automatic reconnect + exponential backoff.
 *
 *   useLive('lists');                          // invalidate ['lists', ...] queries on 'lists.*' events
 *   useLive('messages', (e) => { ... });       // also run a handler for each matching event
 *   useLive('photos', handler, { invalidate: false }); // handler only
 *
 * Matching: an event matches prefix P when type === P or type starts with `${P}.`.
 * After a reconnect every query is invalidated (events may have been missed).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveEvent } from './types';
import { UNAUTHORIZED_EVENT } from './api';

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';
type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();
let source: EventSource | null = null;
let wanted = false;
let everOpened = false;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let status: LiveStatus = 'idle';
/** Family this tab's stream is bound to (?family_id=). */
let streamFamily: number | null = null;

function setStatus(next: LiveStatus) {
  if (status === next) return;
  status = next;
  statusListeners.forEach((l) => l());
}

function open() {
  if (!wanted || source) return;
  setStatus(everOpened ? 'reconnecting' : 'connecting');
  const es = new EventSource(streamFamily ? `/api/stream?family_id=${streamFamily}` : '/api/stream');
  source = es;
  es.onopen = () => {
    attempts = 0;
    if (everOpened) reconnectListeners.forEach((l) => l());
    everOpened = true;
    setStatus('open');
  };
  es.onmessage = (msg) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (event.type === 'session.ended') {
      // Signed out elsewhere / password changed: confirm and hand over to the auth flow.
      es.close();
      if (source === es) source = null;
      void checkSession();
      return;
    }
    listeners.forEach((l) => {
      try {
        l(event);
      } catch (err) {
        console.error('[live] listener failed', err);
      }
    });
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      // Browser gave up (401/403 or server down). If the session is gone, stop and let the
      // auth flow redirect; otherwise retry with backoff.
      es.close();
      if (source === es) source = null;
      void checkSession();
    } else {
      setStatus('reconnecting');
    }
  };
}

async function checkSession() {
  if (!wanted) return;
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = res.ok ? await res.json() : null;
    if (res.ok && !data?.user) {
      stopLive();
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      return;
    }
  } catch {
    /* offline — keep retrying */
  }
  scheduleRetry();
}

function scheduleRetry() {
  if (!wanted || retryTimer) return;
  setStatus('reconnecting');
  const delay = Math.min(30000, 1000 * 2 ** attempts) + Math.random() * 500;
  attempts++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    open();
  }, delay);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted && !source) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      attempts = 0;
      open();
    }
  });
  window.addEventListener('online', () => {
    if (wanted && !source) open();
  });
}

/**
 * Open the shared stream bound to `familyId` (idempotent). Called by AuthProvider after sign-in
 * and whenever this tab switches family (the stream is re-opened for the new family).
 */
export function startLive(familyId: number | null = null) {
  if (source && familyId !== streamFamily) {
    source.close();
    source = null;
    everOpened = false; // a family switch is not a "reconnect" (queries are reset separately)
  }
  streamFamily = familyId;
  wanted = true;
  open();
}

/** Close the stream (sign-out). */
export function stopLive() {
  wanted = false;
  everOpened = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  source?.close();
  source = null;
  setStatus('idle');
}

/** Low-level subscription (non-React code). Returns an unsubscribe function. */
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called after the stream re-opens following a drop. */
export function onLiveReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

export const matchesPrefix = (type: string, prefix: string) => type === prefix || type.startsWith(`${prefix}.`);

/**
 * Subscribe to live events for a module. By default invalidates TanStack queries whose key starts
 * with `[prefix]`; the optional handler runs for every matching event.
 */
export function useLive<P = unknown>(
  prefix: string,
  handler?: (event: LiveEvent<P>) => void,
  options: { invalidate?: boolean; queryKey?: readonly unknown[] } = {},
) {
  const qc = useQueryClient();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const invalidate = options.invalidate !== false;
  const keyJson = JSON.stringify(options.queryKey ?? [prefix]);
  useEffect(() => {
    const queryKey = JSON.parse(keyJson) as unknown[];
    return subscribeLive((event) => {
      if (!matchesPrefix(event.type, prefix)) return;
      handlerRef.current?.(event as LiveEvent<P>);
      if (invalidate) qc.invalidateQueries({ queryKey });
    });
  }, [prefix, invalidate, keyJson, qc]);
}

/** Current connection status (for a small "offline" indicator). */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
    () => 'idle' as LiveStatus,
  );
}
