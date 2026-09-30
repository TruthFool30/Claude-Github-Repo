import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { addDays, addHours, differenceInCalendarDays, differenceInMinutes, format } from 'date-fns';
import { Bell, CalendarDays, Check, MapPin, Palette, Repeat, StickyNote, Users } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { toDate, toDateKey } from '../../lib/format';
import { Button, ColorPicker, Field, Input, MemberPicker, Modal, Select, Switch, Textarea } from '../../ui';
import {
  ACCENT, ALLDAY_REMINDERS, LOCAL_TZ, TIMED_REMINDERS, WEEKDAYS_LONG, WEEKDAYS_SHORT, combine, describeRrule, hhmm, nthOfMonth, occEnd,
  occStart, reminderLabel,
} from './lib';
import type { EventInput, Freq, Occurrence, Rrule } from './types';

export interface EditorState {
  mode: 'create' | 'edit' | 'duplicate';
  occ?: Occurrence;
  /** For create: a start (all-day when allDay). */
  start?: Date;
  allDay?: boolean;
}

interface Props {
  state: EditorState | null;
  onClose: () => void;
  /** `changed` holds only the fields the user edited (timing fields travel together). */
  onSubmit: (input: EventInput, meta: { rruleChanged: boolean; original?: Occurrence; changed: Partial<EventInput> }) => Promise<boolean>;
}

type Preset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly-day' | 'monthly-weekday' | 'yearly' | 'custom';
type EndMode = 'never' | 'until' | 'count';
const ORD = ['first', 'second', 'third', 'fourth', 'last'];

function presetOf(r: Rrule | null, start: Date): Preset {
  if (!r) return 'none';
  const n = r.interval || 1;
  const days = r.byweekday ?? [];
  if (r.freq === 'daily' && n === 1) return 'daily';
  if (r.freq === 'weekly' && n === 1 && days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'weekdays';
  if (r.freq === 'weekly' && days.length === 1 && days[0] === start.getDay()) return n === 1 ? 'weekly' : n === 2 ? 'biweekly' : 'custom';
  if (r.freq === 'monthly' && n === 1) return r.monthly === 'weekday' ? 'monthly-weekday' : 'monthly-day';
  if (r.freq === 'yearly' && n === 1) return 'yearly';
  return 'custom';
}

interface FormState {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  notes: string;
  attendees: number[];
  color: string | null;
  reminders: number[];
  preset: Preset;
  freq: Freq;
  interval: number;
  byweekday: number[];
  monthly: 'day' | 'weekday';
  endMode: EndMode;
  until: string;
  count: number;
}

function initial(state: EditorState, meId: number | undefined): FormState {
  const o = state.occ;
  if (o) {
    const s = occStart(o);
    const e = o.all_day ? toDate(o.end)! : occEnd(o);
    const r = o.rrule;
    return {
      title: state.mode === 'duplicate' ? `${o.title}` : o.title,
      allDay: o.all_day,
      startDate: toDateKey(s),
      startTime: o.all_day ? '09:00' : hhmm(s),
      endDate: toDateKey(e),
      endTime: o.all_day ? '10:00' : hhmm(e),
      location: o.location ?? '',
      notes: o.notes ?? '',
      attendees: o.kind === 'birthday' ? [] : o.attendees,
      color: o.custom_color,
      reminders: o.reminders,
      preset: state.mode === 'duplicate' ? 'none' : presetOf(r, s),
      freq: r?.freq ?? 'weekly',
      interval: r?.interval ?? 1,
      byweekday: r?.byweekday ?? [s.getDay()],
      monthly: r?.monthly ?? 'day',
      endMode: r?.until ? 'until' : r?.count ? 'count' : 'never',
      until: r?.until ?? toDateKey(addDays(s, 90)),
      count: r?.count ?? 10,
    };
  }
  const start = state.start ?? new Date();
  const end = state.allDay ? start : addHours(start, 1);
  return {
    title: '',
    allDay: !!state.allDay,
    startDate: toDateKey(start),
    startTime: state.allDay ? '09:00' : hhmm(start),
    endDate: toDateKey(end),
    endTime: state.allDay ? '10:00' : hhmm(end),
    location: '',
    notes: '',
    attendees: meId ? [meId] : [],
    color: null,
    reminders: [],
    preset: 'none',
    freq: 'weekly',
    interval: 1,
    byweekday: [start.getDay()],
    monthly: 'day',
    endMode: 'never',
    until: toDateKey(addDays(start, 90)),
    count: 10,
  };
}

/** FormState → API payload without validation (null when dates are unusable). */
function toInput(f: FormState): EventInput | null {
  const start = f.allDay ? toDate(f.startDate) : combine(f.startDate, f.startTime);
  const end = f.allDay ? toDate(f.endDate) : combine(f.endDate, f.endTime);
  if (!start || !end) return null;
  return {
    title: f.title.trim(),
    all_day: f.allDay,
    start: f.allDay ? f.startDate : start.toISOString(),
    end: f.allDay ? f.endDate : end.toISOString(),
    tz: LOCAL_TZ,
    location: f.location.trim() || null,
    notes: f.notes.trim() || null,
    color: f.color,
    attendees: [...f.attendees].sort((a, b) => a - b),
    reminders: f.reminders,
    rrule: buildRrule(f, start),
  };
}

const TIMING: Array<keyof EventInput> = ['all_day', 'start', 'end', 'tz'];
/** Only the fields that differ from the original (so a series edit never copies one day's values). */
function diffInput(before: EventInput | null, after: EventInput): Partial<EventInput> {
  if (!before) return after;
  const out: Partial<EventInput> = {};
  const same = (k: keyof EventInput) => JSON.stringify(k === 'rrule' ? normRule(before.rrule) : before[k]) === JSON.stringify(k === 'rrule' ? normRule(after.rrule) : after[k]);
  const keys = Object.keys(after) as Array<keyof EventInput>;
  const timingChanged = TIMING.some((k) => k !== 'tz' && !same(k));
  for (const k of keys) {
    if (k === 'tz') continue; // edits keep the event's own zone (times are absolute instants)
    if (TIMING.includes(k) ? timingChanged : !same(k)) (out as Record<string, unknown>)[k] = after[k];
  }
  return out;
}

function buildRrule(f: FormState, start: Date): Rrule | null {
  let r: Rrule | null;
  switch (f.preset) {
    case 'none': return null;
    case 'daily': r = { freq: 'daily', interval: 1 }; break;
    case 'weekdays': r = { freq: 'weekly', interval: 1, byweekday: [1, 2, 3, 4, 5] }; break;
    case 'weekly': r = { freq: 'weekly', interval: 1, byweekday: [start.getDay()] }; break;
    case 'biweekly': r = { freq: 'weekly', interval: 2, byweekday: [start.getDay()] }; break;
    case 'monthly-day': r = { freq: 'monthly', interval: 1, monthly: 'day' }; break;
    case 'monthly-weekday': r = { freq: 'monthly', interval: 1, monthly: 'weekday' }; break;
    case 'yearly': r = { freq: 'yearly', interval: 1 }; break;
    default:
      r = { freq: f.freq, interval: Math.max(1, Math.min(99, Math.round(f.interval) || 1)) };
      if (f.freq === 'weekly') r.byweekday = f.byweekday.length ? [...f.byweekday].sort() : [start.getDay()];
      if (f.freq === 'monthly') r.monthly = f.monthly;
  }
  if (f.endMode === 'until' && f.until) r.until = f.until;
  if (f.endMode === 'count') r.count = Math.max(1, Math.min(730, Math.round(f.count) || 1));
  return r;
}

const sameRule = (a: Rrule | null, b: Rrule | null) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const normRule = (r: Rrule | null) =>
  r ? { freq: r.freq, interval: r.interval || 1, ...(r.byweekday ? { byweekday: [...r.byweekday].sort() } : {}), ...(r.monthly ? { monthly: r.monthly } : {}), ...(r.until ? { until: r.until } : {}), ...(r.count ? { count: r.count } : {}) } : null;

export function EventEditor({ state, onClose, onSubmit }: Props) {
  const { user, members } = useAuth();
  const [f, setF] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const initialRef = useRef<EventInput | null>(null);
  const open = !!state;
  const creatorColor = members.find((m) => m.id === (state?.mode === 'edit' ? state.occ?.created_by : user?.id))?.color ?? user?.color ?? ACCENT;

  useEffect(() => {
    if (state) {
      const init = initial(state, user?.id);
      setF(init);
      initialRef.current = state.mode === 'edit' ? toInput(init) : null;
      setErrors({});
      setSaving(false);
    }
  }, [state, user?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => (p ? { ...p, [k]: v } : p));

  const start = useMemo(() => (f ? (f.allDay ? toDate(f.startDate) : combine(f.startDate, f.startTime)) : null), [f]);
  const end = useMemo(() => (f ? (f.allDay ? toDate(f.endDate) : combine(f.endDate, f.endTime)) : null), [f]);

  // Keep the duration when the start moves.
  const moveStart = (date: string, time: string) => {
    if (!f) return;
    const oldS = f.allDay ? toDate(f.startDate) : combine(f.startDate, f.startTime);
    const oldE = f.allDay ? toDate(f.endDate) : combine(f.endDate, f.endTime);
    const newS = f.allDay ? toDate(date) : combine(date, time);
    const next = { ...f, startDate: date, startTime: time };
    if (oldS && oldE && newS) {
      if (f.allDay) {
        const span = Math.max(0, differenceInCalendarDays(oldE, oldS));
        next.endDate = toDateKey(addDays(newS, span));
      } else {
        const dur = Math.max(0, differenceInMinutes(oldE, oldS));
        const e = new Date(newS.getTime() + dur * 60_000);
        next.endDate = toDateKey(e);
        next.endTime = hhmm(e);
      }
    }
    // Moving the start to another weekday moves the whole weekly pattern with it (Tue/Thu → Wed/Fri).
    if (f.freq === 'weekly' && newS && oldS && f.byweekday.includes(oldS.getDay())) {
      const d = newS.getDay() - oldS.getDay();
      next.byweekday = [...new Set(f.byweekday.map((w) => (((w + d) % 7) + 7) % 7))].sort((a, b) => a - b);
    }
    setF(next);
  };

  const validate = (): EventInput | null => {
    if (!f) return null;
    const errs: Record<string, string> = {};
    if (!f.title.trim()) errs.title = 'Give your event a name';
    if (!start) errs.start = 'Pick a valid start';
    if (!end) errs.end = 'Pick a valid end';
    if (start && end && (f.allDay ? end < start : end <= start)) errs.end = f.allDay ? 'Ends before it starts' : 'End time must be after the start';
    const rrule = start ? buildRrule(f, start) : null;
    if (rrule?.until && start && toDate(rrule.until)! < toDate(toDateKey(start))!) errs.until = 'Must be on or after the start date';
    if (f.preset === 'custom' && f.freq === 'weekly' && !f.byweekday.length) errs.byweekday = 'Choose at least one day';
    setErrors(errs);
    if (Object.keys(errs).length || !start || !end) {
      if (errs.title) titleRef.current?.focus();
      return null;
    }
    return {
      title: f.title.trim(),
      all_day: f.allDay,
      start: f.allDay ? f.startDate : start.toISOString(),
      end: f.allDay ? f.endDate : end.toISOString(),
      tz: LOCAL_TZ,
      location: f.location.trim() || null,
      notes: f.notes.trim() || null,
      color: f.color,
      attendees: f.attendees,
      reminders: f.reminders,
      rrule,
    };
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const input = validate();
    if (!input || !state) return;
    setSaving(true);
    const original = state.mode === 'edit' ? state.occ : undefined;
    const ok = await onSubmit(input, {
      rruleChanged: !sameRule(normRule(original?.rrule ?? null), normRule(input.rrule)),
      original,
      changed: diffInput(initialRef.current, { ...input, attendees: [...input.attendees].sort((a, b) => a - b) }),
    });
    setSaving(false);
    if (ok) onClose();
  };

  const reminderOptions = f?.allDay ? ALLDAY_REMINDERS : TIMED_REMINDERS;
  const startDay = start ?? new Date();
  const presetOptions: Array<{ value: Preset; label: string }> = [
    { value: 'none', label: 'Does not repeat' },
    { value: 'daily', label: 'Every day' },
    { value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
    { value: 'weekly', label: `Every week on ${WEEKDAYS_LONG[startDay.getDay()]}` },
    { value: 'biweekly', label: `Every 2 weeks on ${WEEKDAYS_LONG[startDay.getDay()]}` },
    { value: 'monthly-day', label: `Every month on day ${startDay.getDate()}` },
    { value: 'monthly-weekday', label: `Every month on the ${ORD[nthOfMonth(startDay) - 1]} ${WEEKDAYS_LONG[startDay.getDay()]}` },
    { value: 'yearly', label: `Every year on ${format(startDay, 'MMMM d')}` },
    { value: 'custom', label: 'Custom…' },
  ];
  const title = state?.mode === 'edit' ? 'Edit event' : state?.mode === 'duplicate' ? 'Duplicate event' : 'New event';
  const rrulePreview = f && start ? buildRrule(f, start) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      title={title}
      icon={
        <span className="flex size-10 items-center justify-center rounded-2xl" style={{ backgroundColor: `color-mix(in oklab, ${ACCENT} 14%, transparent)`, color: ACCENT }}>
          <CalendarDays size={20} />
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="calendar-event-form" loading={saving} icon={Check}>
            {state?.mode === 'edit' ? 'Save changes' : 'Add event'}
          </Button>
        </>
      }
    >
      {f && (
        <form id="calendar-event-form" onSubmit={submit} className="space-y-5" noValidate>
          <Field label="Title" required error={errors.title}>
            <Input
              ref={titleRef}
              autoFocus={state?.mode !== 'edit'}
              value={f.title}
              maxLength={120}
              placeholder="Soccer practice, dentist, date night…"
              onChange={(e) => set('title', e.target.value)}
              name="title"
            />
          </Field>

          <div className="rounded-2xl border border-border bg-surface-2/40 p-3.5 sm:p-4">
            <Switch
              checked={f.allDay}
              onChange={(v) => {
                if (v) setF({ ...f, allDay: true, endDate: f.endDate < f.startDate ? f.startDate : f.endDate, reminders: f.reminders.filter((m) => ALLDAY_REMINDERS.includes(m)) });
                else {
                  const s = combine(f.startDate, f.startTime)!;
                  const e = addHours(s, 1);
                  setF({ ...f, allDay: false, endDate: toDateKey(e), endTime: hhmm(e) });
                }
              }}
              label="All day"
            />
            <div className="mt-3.5 grid grid-cols-1 gap-y-1.5 sm:grid-cols-[3.5rem_1fr] sm:items-start sm:gap-x-3 sm:gap-y-3">
              <span className="text-[13px] font-semibold text-muted sm:pt-2.5">Starts</span>
              <div className="flex min-w-0 gap-2">
                <Input type="date" aria-label="Start date" value={f.startDate} onChange={(e) => e.target.value && moveStart(e.target.value, f.startTime)} className="min-w-0 flex-1" required />
                {!f.allDay && <div className="w-[8.5rem] shrink-0"><Input type="time" aria-label="Start time" step={300} value={f.startTime} onChange={(e) => e.target.value && moveStart(f.startDate, e.target.value)} required /></div>}
              </div>
              <span className="mt-2 text-[13px] font-semibold text-muted sm:mt-0 sm:pt-2.5">Ends</span>
              <div className="min-w-0">
                <div className="flex min-w-0 gap-2">
                  <Input type="date" aria-label="End date" value={f.endDate} min={f.startDate} invalid={!!errors.end} onChange={(e) => e.target.value && set('endDate', e.target.value)} className="min-w-0 flex-1" required />
                  {!f.allDay && <div className="w-[8.5rem] shrink-0"><Input type="time" aria-label="End time" step={300} value={f.endTime} invalid={!!errors.end} onChange={(e) => e.target.value && set('endTime', e.target.value)} required /></div>}
                </div>
                {errors.end && <p className="mt-1.5 text-xs font-medium text-danger" role="alert">{errors.end}</p>}
              </div>
            </div>
          </div>

          <Field label={<span className="inline-flex items-center gap-1.5"><Repeat size={14} /> Repeat</span>} hint={f.preset !== 'none' && rrulePreview ? describeRrule(rrulePreview, startDay) : undefined}>
            <Select value={f.preset} onChange={(e) => set('preset', e.target.value as Preset)} options={presetOptions} />
          </Field>

          {f.preset === 'custom' && (
            <div className="space-y-4 rounded-2xl border border-border p-3.5 sm:p-4 animate-fade-in">
              <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
                <span className="font-medium">Every</span>
                <div className="w-20"><Input type="number" aria-label="Repeat interval" min={1} max={99} value={f.interval} onChange={(e) => set('interval', Number(e.target.value))} size="sm" /></div>
                <Select
                  aria-label="Repeat unit"
                  size="sm"
                  className="w-32"
                  value={f.freq}
                  onChange={(e) => set('freq', e.target.value as Freq)}
                  options={[
                    { value: 'daily', label: f.interval === 1 ? 'day' : 'days' },
                    { value: 'weekly', label: f.interval === 1 ? 'week' : 'weeks' },
                    { value: 'monthly', label: f.interval === 1 ? 'month' : 'months' },
                    { value: 'yearly', label: f.interval === 1 ? 'year' : 'years' },
                  ]}
                />
              </div>
              {f.freq === 'weekly' && (
                <div>
                  <div className="mb-2 text-[13px] font-semibold text-fg">On</div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Repeat on weekdays">
                    {WEEKDAYS_SHORT.map((d, i) => {
                      const on = f.byweekday.includes(i);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          aria-label={WEEKDAYS_LONG[i]}
                          onClick={() => set('byweekday', on ? f.byweekday.filter((x) => x !== i) : [...f.byweekday, i])}
                          className={cn(
                            'flex size-10 items-center justify-center rounded-full text-[13px] font-semibold transition active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                            on ? 'bg-primary-solid text-white' : 'bg-surface-2 text-muted hover:text-fg',
                          )}
                        >
                          {d.slice(0, 2)}
                        </button>
                      );
                    })}
                  </div>
                  {errors.byweekday && <p className="mt-1.5 text-xs font-medium text-danger">{errors.byweekday}</p>}
                </div>
              )}
              {f.freq === 'monthly' && (
                <Select
                  aria-label="Monthly on"
                  value={f.monthly}
                  onChange={(e) => set('monthly', e.target.value as 'day' | 'weekday')}
                  options={[
                    { value: 'day', label: `On day ${startDay.getDate()}` },
                    { value: 'weekday', label: `On the ${ORD[nthOfMonth(startDay) - 1]} ${WEEKDAYS_LONG[startDay.getDay()]}` },
                  ]}
                />
              )}
            </div>
          )}

          {f.preset !== 'none' && (
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr] animate-fade-in">
              <Field label="Ends">
                <Select
                  value={f.endMode}
                  onChange={(e) => set('endMode', e.target.value as EndMode)}
                  options={[
                    { value: 'never', label: 'Never' },
                    { value: 'until', label: 'On a date' },
                    { value: 'count', label: 'After a number of times' },
                  ]}
                />
              </Field>
              {f.endMode === 'until' && (
                <Field label="Last date" error={errors.until}>
                  <Input type="date" value={f.until} min={f.startDate} onChange={(e) => set('until', e.target.value)} />
                </Field>
              )}
              {f.endMode === 'count' && (
                <Field label="Occurrences">
                  <Input type="number" min={1} max={730} value={f.count} onChange={(e) => set('count', Number(e.target.value))} />
                </Field>
              )}
            </div>
          )}

          <Field label={<span className="inline-flex items-center gap-1.5"><Users size={14} /> Who's going</span>} hint="People who get reminders and see it under their color">
            <MemberPicker multiple showAll value={f.attendees} onChange={(ids) => set('attendees', ids)} />
          </Field>

          <Field label={<span className="inline-flex items-center gap-1.5"><MapPin size={14} /> Location</span>}>
            <Input value={f.location} maxLength={200} placeholder="Add a place" onChange={(e) => set('location', e.target.value)} icon={MapPin} />
          </Field>

          <Field label={<span className="inline-flex items-center gap-1.5"><Bell size={14} /> Reminders</span>} hint={f.reminders.length >= 5 ? 'Up to 5 reminders' : 'Everyone going gets an in-app notification'}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Reminders">
              {reminderOptions.map((m) => {
                const on = f.reminders.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    disabled={!on && f.reminders.length >= 5}
                    onClick={() => set('reminders', on ? f.reminders.filter((x) => x !== m) : [...f.reminders, m].sort((a, b) => a - b))}
                    className={cn(
                      'inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] font-medium transition active:scale-95 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                      on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-fg',
                    )}
                  >
                    {on && <Check size={13} />}
                    {reminderLabel(m, f.allDay)}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={<span className="inline-flex items-center gap-1.5"><Palette size={14} /> Color</span>}>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                aria-pressed={f.color === null}
                onClick={() => set('color', null)}
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                  f.color === null ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-border text-muted hover:text-fg',
                )}
              >
                <span className="size-3.5 rounded-full" style={{ backgroundColor: creatorColor }} aria-hidden />
                Creator's color
              </button>
              <ColorPicker value={f.color} onChange={(c) => set('color', c)} size="sm" />
            </div>
          </Field>

          <Field label={<span className="inline-flex items-center gap-1.5"><StickyNote size={14} /> Notes</span>}>
            <Textarea
              autoGrow
              rows={3}
              maxLength={4000}
              value={f.notes}
              placeholder="What to bring, who's driving, details…"
              onChange={(e) => set('notes', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
              }}
            />
          </Field>
        </form>
      )}
    </Modal>
  );
}
