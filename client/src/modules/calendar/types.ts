export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Rrule {
  freq: Freq;
  interval: number;
  byweekday?: number[];
  monthly?: 'day' | 'weekday';
  until?: string;
  count?: number;
}

/** One occurrence as returned by GET /api/calendar/events (events + member birthdays). */
export interface Occurrence {
  /** Unique per occurrence: "12", "12:<occurrence key>" or "birthday-<user>-<year>". */
  id: string;
  event_id: number | null;
  /** Original start of this occurrence of a series (null for single events). */
  occurrence: string | null;
  kind: 'event' | 'birthday';
  user_id?: number;
  age?: number;
  title: string;
  /** All-day: 'YYYY-MM-DD'; timed: ISO instant. */
  start: string;
  /** All-day: inclusive 'YYYY-MM-DD'; timed: ISO instant. */
  end: string;
  all_day: boolean;
  tz: string | null;
  color: string;
  custom_color: string | null;
  location: string | null;
  notes: string | null;
  attendees: number[];
  reminders: number[];
  rrule: Rrule | null;
  recurring: boolean;
  exception: boolean;
  created_by: number | null;
  creator_name: string | null;
  can_edit: boolean;
  /** Client-only: optimistic placeholder while saving. */
  pending?: boolean;
}

export interface EventSeries {
  id: number;
  title: string;
  notes: string | null;
  location: string | null;
  all_day: boolean;
  start: string;
  end: string;
  tz: string;
  color: string;
  custom_color: string | null;
  rrule: Rrule | null;
  reminders: number[];
  attendees: number[];
  recurring: boolean;
  created_by: number | null;
  creator_name: string | null;
  can_edit: boolean;
  occurrence?: Occurrence | null;
  split_from?: number;
  /** Per-day edits that no longer matched the series after a change and were reset. */
  dropped_exceptions?: number;
}

export type View = 'month' | 'week' | 'day' | 'agenda';
export type Scope = 'this' | 'following' | 'all';

/** Payload for POST/PATCH /api/calendar/events. */
export interface EventInput {
  title: string;
  all_day: boolean;
  start: string;
  end: string;
  tz: string;
  location: string | null;
  notes: string | null;
  color: string | null;
  attendees: number[];
  reminders: number[];
  rrule: Rrule | null;
}
