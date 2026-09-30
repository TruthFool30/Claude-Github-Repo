import { useCallback, useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  addDays, addMonths, differenceInCalendarDays, differenceInMinutes, endOfMonth, format, isSameDay, isSameYear, startOfDay,
  startOfMonth, startOfWeek,
} from 'date-fns';
import { api, errorMessage, qs } from '../../lib/api';
import { toDate, toDateKey } from '../../lib/format';
import { toast } from '../../ui';
import type { EventInput, EventSeries, Occurrence, Rrule, Scope, View } from './types';

export const ACCENT = '#0090FF';
export const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'last'];

// ---- occurrence time helpers -------------------------------------------------------------------

/** Start as a local Date (all-day → local midnight). */
export const occStart = (o: Pick<Occurrence, 'start'>): Date => toDate(o.start) ?? new Date(NaN);
/** Exclusive end as a local Date (all-day → midnight after the last day). */
export function occEnd(o: Pick<Occurrence, 'end' | 'all_day'>): Date {
  const d = toDate(o.end) ?? new Date(NaN);
  return o.all_day ? addDays(d, 1) : d;
}
/** Number of calendar days an occurrence touches. */
export function spanDays(o: Occurrence): number {
  const s = occStart(o);
  const e = new Date(Math.max(occEnd(o).getTime() - 1, s.getTime()));
  return differenceInCalendarDays(e, s) + 1;
}
/** Does the occurrence touch this local day? */
export function occursOn(o: Occurrence, day: Date): boolean {
  const d0 = startOfDay(day).getTime();
  const d1 = addDays(startOfDay(day), 1).getTime();
  const s = occStart(o).getTime();
  const e = occEnd(o).getTime();
  if (e === s) return s >= d0 && s < d1;
  return s < d1 && e > d0;
}
export const isMultiDay = (o: Occurrence) => spanDays(o) > 1;
/** Timed events shown in the all-day lane (they span 24h+). */
export const inAllDayLane = (o: Occurrence) => o.all_day || occEnd(o).getTime() - occStart(o).getTime() >= 24 * 3600_000;

export function sortOccurrences(list: Occurrence[]): Occurrence[] {
  return [...list].sort(
    (a, b) => Number(b.all_day) - Number(a.all_day) || occStart(a).getTime() - occStart(b).getTime() || a.title.localeCompare(b.title),
  );
}

export const ownersOf = (o: Occurrence): number[] => (o.attendees.length ? o.attendees : o.created_by ? [o.created_by] : []);

// ---- formatting -----------------------------------------------------------------------------

export function fmtClock(d: Date): string {
  return format(d, d.getMinutes() === 0 ? 'h a' : 'h:mm a');
}
/** "9:30 – 10:15 AM" / "11 AM – 1 PM" */
export function fmtTimeRange(s: Date, e: Date): string {
  const sameHalf = format(s, 'a') === format(e, 'a');
  const left = sameHalf ? format(s, s.getMinutes() === 0 ? 'h' : 'h:mm') : fmtClock(s);
  return `${left} – ${fmtClock(e)}`;
}
/** Full human "when" line for the detail view. */
export function fmtWhen(o: Occurrence): { primary: string; secondary?: string } {
  const s = occStart(o);
  const eIncl = o.all_day ? toDate(o.end)! : occEnd(o);
  const dayFmt = (d: Date) => format(d, isSameYear(d, new Date()) ? 'EEEE, MMMM d' : 'EEEE, MMMM d, yyyy');
  if (o.all_day) {
    const days = spanDays(o);
    if (days === 1) return { primary: dayFmt(s), secondary: 'All day' };
    return { primary: `${format(s, 'EEE, MMM d')} – ${format(eIncl, 'EEE, MMM d')}`, secondary: `All day · ${days} days` };
  }
  if (isSameDay(s, eIncl) || (eIncl.getTime() - s.getTime() < 12 * 3600_000 && differenceInCalendarDays(eIncl, s) <= 1 && eIncl.getHours() < 6)) {
    return { primary: dayFmt(s), secondary: s.getTime() === eIncl.getTime() ? fmtClock(s) : `${fmtTimeRange(s, eIncl)} · ${fmtDuration(s, eIncl)}` };
  }
  return { primary: `${format(s, 'EEE, MMM d')}, ${fmtClock(s)} – ${format(eIncl, 'EEE, MMM d')}, ${fmtClock(eIncl)}` };
}
export function fmtDuration(s: Date, e: Date): string {
  const m = differenceInMinutes(e, s);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function nthOfMonth(d: Date): number {
  return Math.ceil(d.getDate() / 7); // 1..5 (5 = last)
}

/** "Every week on Tue, Thu", "Every 2 months on the second Tuesday until Dec 1" */
export function describeRrule(r: Rrule | null, start: Date): string {
  if (!r) return 'Does not repeat';
  const n = r.interval || 1;
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === 'daily' && n === 1) s = 'Daily';
  if (r.freq === 'weekly') {
    const days = r.byweekday?.length ? r.byweekday : [start.getDay()];
    const weekdays = [1, 2, 3, 4, 5];
    if (n === 1 && days.length === 5 && weekdays.every((d) => days.includes(d))) s = 'Every weekday';
    else s += ` on ${days.map((d) => WEEKDAYS_SHORT[d]).join(', ')}`;
  }
  if (r.freq === 'monthly') {
    s += r.monthly === 'weekday' ? ` on the ${ORDINALS[nthOfMonth(start) - 1]} ${WEEKDAYS_LONG[start.getDay()]}` : ` on day ${start.getDate()}`;
  }
  if (r.freq === 'yearly') s += ` on ${format(start, 'MMMM d')}`;
  if (r.until) s += `, until ${format(toDate(r.until)!, 'MMM d, yyyy')}`;
  if (r.count) s += `, ${r.count} times`;
  return s;
}

export function reminderLabel(m: number, allDay: boolean): string {
  if (allDay) {
    if (m === 0) return 'On the day (9 AM)';
    if (m % 10080 === 0) return `${m / 10080} week${m === 10080 ? '' : 's'} before (9 AM)`;
    if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'} before (9 AM)`;
  }
  if (m === 0) return 'At start time';
  if (m < 60) return `${m} min before`;
  if (m % 10080 === 0) return `${m / 10080} week${m === 10080 ? '' : 's'} before`;
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'} before`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'} before`;
  return `${m} min before`;
}
export const TIMED_REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
export const ALLDAY_REMINDERS = [0, 1440, 2880, 10080];

export function mapsUrl(location: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

// ---- ranges -----------------------------------------------------------------------------------

/** Days shown by the week view: a full week on desktop, 3 days from the cursor on phones. */
export const weekDays = (compact: boolean) => (compact ? 3 : 7);

export function viewRange(view: View, cursor: Date, weekStartsOn: 0 | 1, agendaDays = 42, compact = false): { from: Date; to: Date } {
  const day = startOfDay(cursor);
  switch (view) {
    case 'month': {
      const from = startOfWeek(startOfMonth(day), { weekStartsOn });
      return { from, to: addDays(from, 42) };
    }
    case 'week': {
      if (compact) return { from: day, to: addDays(day, 3) };
      const from = startOfWeek(day, { weekStartsOn });
      return { from, to: addDays(from, 7) };
    }
    case 'day':
      return { from: day, to: addDays(day, 1) };
    default:
      return { from: day, to: addDays(day, agendaDays) };
  }
}

export function stepCursor(view: View, cursor: Date, dir: 1 | -1, compact = false): Date {
  if (view === 'month') return startOfMonth(addMonths(cursor, dir));
  if (view === 'week') return addDays(cursor, (compact ? 3 : 7) * dir);
  if (view === 'day') return addDays(cursor, dir);
  return addDays(cursor, 14 * dir);
}

export function rangeTitle(view: View, cursor: Date, weekStartsOn: 0 | 1, compact = false): string {
  if (view === 'month') return format(cursor, 'MMMM yyyy');
  if (view === 'day') return format(cursor, compact ? 'EEE, MMM d' : isSameYear(cursor, new Date()) ? 'EEE, MMMM d' : 'EEE, MMM d, yyyy');
  if (view === 'week') {
    const s = compact ? startOfDay(cursor) : startOfWeek(cursor, { weekStartsOn });
    const e = addDays(s, compact ? 2 : 6);
    if (compact) return s.getMonth() === e.getMonth() ? `${format(s, 'MMM d')} – ${format(e, 'd')}` : `${format(s, 'MMM d')} – ${format(e, 'MMM d')}`;
    if (s.getMonth() === e.getMonth()) return `${format(s, 'MMM d')} – ${format(e, 'd, yyyy')}`;
    if (s.getFullYear() === e.getFullYear()) return `${format(s, 'MMM d')} – ${format(e, 'MMM d, yyyy')}`;
    return `${format(s, 'MMM d, yyyy')} – ${format(e, 'MMM d, yyyy')}`;
  }
  return compact ? format(cursor, 'MMM yyyy') : `From ${format(cursor, 'MMMM d')}`;
}

export const monthEnd = endOfMonth;

// ---- data ------------------------------------------------------------------------------------

export const eventsKey = (from: Date, to: Date): QueryKey => ['calendar', 'events', toDateKey(from), toDateKey(to)];

export function useEvents(from: Date, to: Date, showBirthdays = true) {
  return useQuery({
    queryKey: [...eventsKey(from, to), showBirthdays ? 'b' : 'nb'],
    queryFn: () =>
      api.get<Occurrence[]>(
        `/calendar/events${qs({ from: from.toISOString(), to: to.toISOString(), tz: LOCAL_TZ, birthdays: showBirthdays ? undefined : 0 })}`,
      ),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useUpcoming() {
  return useQuery({
    queryKey: ['calendar', 'upcoming'],
    queryFn: () => api.get<Occurrence[]>(`/calendar/upcoming${qs({ tz: LOCAL_TZ, days: 14, limit: 6 })}`),
    staleTime: 30_000,
  });
}

/** Build a client-side placeholder occurrence (optimistic create). */
function placeholder(input: EventInput, color: string, userId: number): Occurrence {
  return {
    id: `tmp-${Math.random().toString(36).slice(2)}`,
    event_id: null,
    occurrence: null,
    kind: 'event',
    title: input.title,
    start: input.start,
    end: input.end,
    all_day: input.all_day,
    tz: input.tz,
    color: input.color ?? color,
    custom_color: input.color,
    location: input.location,
    notes: input.notes,
    attendees: input.attendees,
    reminders: input.reminders,
    rrule: input.rrule,
    recurring: !!input.rrule,
    exception: false,
    created_by: userId,
    creator_name: null,
    can_edit: false,
    pending: true,
  };
}

type Snapshot = Array<[QueryKey, Occurrence[] | undefined]>;

/** Create / update / delete with optimistic cache updates on every loaded range. */
export function useCalendarMutations(me: { id: number; color: string } | null) {
  const qc = useQueryClient();
  const snapshot = (): Snapshot => qc.getQueriesData<Occurrence[]>({ queryKey: ['calendar', 'events'] });
  const restore = (s: Snapshot) => s.forEach(([k, v]) => qc.setQueryData(k, v));
  const patchAll = (fn: (list: Occurrence[]) => Occurrence[]) =>
    qc.setQueriesData<Occurrence[]>({ queryKey: ['calendar', 'events'] }, (old) => (old ? fn(old) : old));
  const settle = () => qc.invalidateQueries({ queryKey: ['calendar'] });

  const create = useMutation({
    mutationFn: (input: EventInput) => api.post<EventSeries>('/calendar/events', input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['calendar', 'events'] });
      const snap = snapshot();
      if (!input.rrule && me) patchAll((list) => sortOccurrences([...list, placeholder(input, me.color, me.id)]));
      return { snap };
    },
    onError: (e, _v, c) => {
      if (c) restore(c.snap);
      toast.error(errorMessage(e));
    },
    onSettled: settle,
  });

  const update = useMutation({
    mutationFn: ({ occ, input, scope }: { occ: Occurrence; input: Partial<EventInput>; scope: Scope }) =>
      api.patch<EventSeries>(`/calendar/events/${occ.event_id}`, { ...input, scope, occurrence: occ.occurrence ?? undefined }),
    onMutate: async ({ occ, input, scope }) => {
      await qc.cancelQueries({ queryKey: ['calendar', 'events'] });
      const snap = snapshot();
      // Optimistically apply simple edits to the occurrence the user is looking at.
      if (scope === 'this' || !occ.recurring) {
        patchAll((list) => list.map((o) => (o.id === occ.id ? { ...o, ...input, color: input.color ?? o.color, rrule: o.rrule } as Occurrence : o)));
      }
      return { snap };
    },
    onError: (e, _v, c) => {
      if (c) restore(c.snap);
      toast.error(errorMessage(e));
    },
    onSettled: settle,
  });

  const remove = useMutation({
    mutationFn: ({ occ, scope }: { occ: Occurrence; scope: Scope }) =>
      api.del<{ ok: true }>(`/calendar/events/${occ.event_id}`, { scope, occurrence: occ.occurrence ?? undefined }),
    onMutate: async ({ occ, scope }) => {
      await qc.cancelQueries({ queryKey: ['calendar', 'events'] });
      const snap = snapshot();
      const cut = occStart(occ).getTime();
      patchAll((list) =>
        list.filter((o) => {
          if (o.event_id !== occ.event_id) return true;
          if (scope === 'all' || !occ.recurring) return false;
          if (scope === 'this') return o.id !== occ.id;
          return !(o.occurrence && (toDate(o.occurrence)?.getTime() ?? 0) >= (toDate(occ.occurrence)?.getTime() ?? cut));
        }),
      );
      return { snap };
    },
    onError: (e, _v, c) => {
      if (c) restore(c.snap);
      toast.error(errorMessage(e));
    },
    onSettled: settle,
  });

  return { create, update, remove };
}

// ---- preferences -------------------------------------------------------------------------------

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/** A small persisted per-browser preference. */
export function usePref<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readLS(`hearth-cal-${key}`, fallback));
  useEffect(() => writeLS(`hearth-cal-${key}`, value), [key, value]);
  const set = useCallback((v: T | ((prev: T) => T)) => setValue(v), []);
  return [value, set];
}

// ---- week/day layout -----------------------------------------------------------------------------

export interface Positioned {
  occ: Occurrence;
  /** minutes from midnight (clipped to the day) */
  top: number;
  bottom: number;
  col: number;
  cols: number;
  /** Columns this event may fill to its right without covering anything (≥1). */
  span: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Side-by-side layout for timed events on one day (Google-style columns per overlap cluster). */
export function layoutDay(list: Occurrence[], day: Date): Positioned[] {
  const d0 = startOfDay(day).getTime();
  const d1 = addDays(startOfDay(day), 1).getTime();
  const items = list
    .filter((o) => !inAllDayLane(o) && occursOn(o, day))
    .map((o) => {
      const s = occStart(o).getTime();
      const e = occEnd(o).getTime();
      const top = Math.max(0, (s - d0) / 60_000);
      const bottom = Math.min(1440, (Math.max(e, s + 1) - d0) / 60_000);
      return { occ: o, top, bottom: Math.max(bottom, top + 20), col: 0, cols: 1, span: 1, continuesBefore: s < d0, continuesAfter: e > d1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  let cluster: typeof items = [];
  let clusterEnd = -1;
  const flush = () => {
    const colsEnd: number[] = [];
    for (const it of cluster) {
      let c = colsEnd.findIndex((end) => end <= it.top);
      if (c === -1) {
        c = colsEnd.length;
        colsEnd.push(it.bottom);
      } else colsEnd[c] = it.bottom;
      it.col = c;
    }
    for (const it of cluster) {
      it.cols = colsEnd.length;
      let span = 1;
      while (
        it.col + span < it.cols &&
        !cluster.some((o) => o.col === it.col + span && o.top < it.bottom && o.bottom > it.top)
      ) span++;
      it.span = span;
    }
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.top >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  if (cluster.length) flush();
  return items;
}

// ---- editor helpers -------------------------------------------------------------------------

/** Round up to the next half hour. */
export function nextHalfHour(from = new Date()): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m <= 30 ? 30 : 60);
  if (m === 0 || m === 30) d.setMinutes(m + 30);
  return d;
}

export const hhmm = (d: Date) => format(d, 'HH:mm');
/** Combine 'YYYY-MM-DD' + 'HH:mm' into a local Date. */
export function combine(date: string, time: string): Date | null {
  const d = toDate(date);
  if (!d || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Download the .ics for an event (sends the tab's family header). */
export async function downloadIcs(eventId: number, title: string, familyId: number | null) {
  try {
    const res = await fetch(`/api/calendar/events/${eventId}/ics`, {
      credentials: 'same-origin',
      headers: familyId ? { 'X-Family-Id': String(familyId) } : undefined,
    });
    if (!res.ok) throw new Error('Could not export this event');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'event'}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}
