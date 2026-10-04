/**
 * Continuous location sharing "while the app is open".
 * A single watchPosition for the whole tab (survives navigating away from the Locator page),
 * throttled: a report is sent at most every MIN_INTERVAL, or sooner after moving MIN_MOVE meters.
 * Stops on sign-out/family switch (see LocatorPage), when sharing is paused (server 409) or on
 * permission errors. Never persisted: it always starts switched off after a reload.
 */
import { useSyncExternalStore } from 'react';
import { api, ApiError, errorMessage, getApiFamily } from '../../lib/api';
import { readBattery, geoErrorMessage } from './data';
import { distanceMeters } from './geo';

const MIN_INTERVAL = 30_000;
const MIN_MOVE = 50;
const HEARTBEAT = 3 * 60_000;

export interface LiveShareState {
  active: boolean;
  familyId: number | null;
  lastSentAt: number | null;
  error: string | null;
  sending: boolean;
}

let state: LiveShareState = { active: false, familyId: null, lastSentAt: null, error: null, sending: false };
const listeners = new Set<() => void>();
let watchId: number | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let last: { lat: number; lng: number; accuracy: number | null; at: number } | null = null;
let lastSentPos: { lat: number; lng: number } | null = null;
let onSent: (() => void) | null = null;

function set(patch: Partial<LiveShareState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

async function send(force = false) {
  if (!state.active || !last || state.sending) return;
  const now = Date.now();
  const moved = lastSentPos ? distanceMeters(lastSentPos, last) : Infinity;
  if (!force && state.lastSentAt && now - state.lastSentAt < MIN_INTERVAL && moved < MIN_MOVE) return;
  if (getApiFamily() !== state.familyId) {
    stopLiveShare();
    return;
  }
  set({ sending: true });
  try {
    const battery = await readBattery();
    await api.post('/locator/checkins', { lat: last.lat, lng: last.lng, accuracy: last.accuracy, battery, source: 'live' });
    lastSentPos = { lat: last.lat, lng: last.lng };
    set({ lastSentAt: Date.now(), error: null, sending: false });
    onSent?.();
  } catch (e) {
    set({ sending: false });
    if (e instanceof ApiError && (e.status === 409 || e.status === 401 || e.status === 403)) {
      stopLiveShare(e.status === 409 ? 'Sharing is paused, so live location was switched off.' : null);
    } else {
      set({ error: errorMessage(e) || 'Couldn’t send your location — retrying' });
    }
  }
}

export function startLiveShare(familyId: number, afterSend?: () => void) {
  if (state.active && state.familyId === familyId) return;
  stopLiveShare();
  if (!('geolocation' in navigator)) {
    set({ error: 'This browser can’t share its location.' });
    return;
  }
  onSent = afterSend ?? null;
  set({ active: true, familyId, error: null, lastSentAt: null });
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      last = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? Math.round(p.coords.accuracy) : null, at: Date.now() };
      void send();
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) stopLiveShare(geoErrorMessage(err));
      else set({ error: geoErrorMessage(err) });
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
  );
  // Keep "updated x min ago" fresh even when standing still.
  heartbeat = setInterval(() => void send(true), HEARTBEAT);
}

export function stopLiveShare(error: string | null = null) {
  if (watchId !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(watchId);
  if (heartbeat) clearInterval(heartbeat);
  watchId = null;
  heartbeat = null;
  last = null;
  lastSentPos = null;
  onSent = null;
  set({ active: false, familyId: null, sending: false, error });
}

export function useLiveShare(): LiveShareState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}
