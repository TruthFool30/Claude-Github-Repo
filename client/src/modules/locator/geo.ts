import type { LatLng, MemberLocation } from './types';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "80 m" / "1.2 km" / "14 km" */
export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.max(1, Math.round(m / 10) * 10)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** "30.30052° N, 97.75611° W" */
export function fmtCoords(lat: number, lng: number, digits = 5): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(digits)}° ${lng >= 0 ? 'E' : 'W'}`;
}

/** Minutes since an ISO timestamp. */
export const minutesSince = (iso: string, now = Date.now()) => Math.max(0, (now - Date.parse(iso)) / 60000);

/** "just now" / "5 min ago" / "2 h ago" / "3 days ago" */
export function ago(iso: string, now = Date.now()): string {
  const m = minutesSince(iso, now);
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  const d = Math.round(m / 1440);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Duration between two ISO timestamps: "45 min", "2 h 10 min". */
export function fmtDuration(fromIso: string, toIso: string): string {
  const mins = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  if (mins < 1) return 'a moment';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Location older than this is shown as stale ("last seen"). */
export const STALE_MINUTES = 120;
export const isStale = (loc: MemberLocation | null, now = Date.now()) => !!loc && minutesSince(loc.updated_at, now) > STALE_MINUTES;
/** Live sharing reported within the last few minutes. */
export const isLiveNow = (loc: MemberLocation | null, now = Date.now()) => !!loc && loc.source === 'live' && minutesSince(loc.updated_at, now) < 10;
