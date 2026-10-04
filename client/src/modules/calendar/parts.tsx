import type { CSSProperties, ReactNode } from 'react';
import { Cake, MapPin, Repeat } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { readableOn } from '../../lib/color';
import { cn } from '../../lib/cn';
import { AvatarStack } from '../../ui';
import { fmtClock, fmtTimeRange, occEnd, occStart, isMultiDay, spanDays } from './lib';
import type { Occurrence } from './types';
import { differenceInCalendarDays, startOfDay } from 'date-fns';

/** Soft tint of an event color that reads well in both themes. */
export const tint = (color: string, pct = 16): CSSProperties => ({
  backgroundColor: `color-mix(in oklab, ${color} ${pct}%, var(--surface))`,
});

/** Accessible one-line description for screen readers. */
export function occAria(o: Occurrence): string {
  if (o.kind === 'birthday') return `${o.title}${o.age ? `, turns ${o.age}` : ''}`;
  const when = o.all_day
    ? isMultiDay(o) ? `all day, ${spanDays(o)} days` : 'all day'
    : fmtTimeRange(occStart(o), occEnd(o));
  return `${o.title}, ${when}${o.location ? `, at ${o.location}` : ''}${o.recurring ? ', repeats' : ''}`;
}

/** Compact chip used in month cells and the all-day lane. */
export function EventPill({
  occ, day, onOpen, compact, className,
}: { occ: Occurrence; day?: Date; onOpen: (o: Occurrence) => void; compact?: boolean; className?: string }) {
  const solid = occ.all_day || occ.kind === 'birthday' || isMultiDay(occ);
  const { bg, fg } = readableOn(occ.color);
  const s = occStart(occ);
  const first = !day || differenceInCalendarDays(startOfDay(day), startOfDay(s)) <= 0;
  const last = !day || differenceInCalendarDays(startOfDay(occEnd(occ).getTime() - 1), startOfDay(day)) <= 0;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(occ);
      }}
      aria-label={occAria(occ)}
      data-event-id={occ.id}
      className={cn(
        'group/pill flex w-full min-w-0 items-center gap-1.5 truncate text-left text-[12px] font-semibold leading-5 transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        solid ? 'px-1.5 hover:brightness-110' : 'rounded-md px-1 text-fg hover:bg-surface-2',
        solid && (first ? 'rounded-l-md' : 'rounded-l-none'),
        solid && (last ? 'rounded-r-md' : 'rounded-r-none'),
        occ.pending && 'opacity-60',
        className,
      )}
      style={solid ? { backgroundColor: bg, color: fg } : undefined}
    >
      {!solid && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: occ.color }} aria-hidden />}
      {occ.kind === 'birthday' && <Cake size={12} className="shrink-0" aria-hidden />}
      {!solid && !compact && <span className="hidden shrink-0 font-medium tabular-nums text-muted @[124px]:inline">{fmtClock(s).replace(' ', '').toLowerCase()}</span>}
      <span className="truncate">{!first && solid ? `↳ ${occ.title}` : occ.title}</span>
    </button>
  );
}

/** Row used in agenda lists / day lists: time column, color bar, title, meta, people. */
export function OccurrenceRow({ occ, onOpen, trailing }: { occ: Occurrence; onOpen: (o: Occurrence) => void; trailing?: ReactNode }) {
  const { members } = useAuth();
  const people = occ.attendees.map((id) => members.find((m) => m.id === id)).filter(Boolean) as typeof members;
  const s = occStart(occ);
  const e = occEnd(occ);
  const past = e.getTime() < Date.now();
  return (
    <button
      type="button"
      onClick={() => onOpen(occ)}
      aria-label={occAria(occ)}
      data-event-id={occ.id}
      className={cn(
        'group flex w-full items-stretch gap-3 rounded-2xl px-2.5 py-2.5 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        occ.pending && 'opacity-60',
      )}
    >
      <div className="w-[62px] shrink-0 pt-0.5 text-right">
        {occ.all_day ? (
          <span className="text-[12px] font-semibold text-muted">All day</span>
        ) : (
          <>
            <div className={cn('text-[13px] font-semibold tabular-nums', past ? 'text-subtle' : 'text-fg')}>{fmtClock(s)}</div>
            <div className="text-[11px] tabular-nums text-subtle">{fmtClock(e)}</div>
          </>
        )}
      </div>
      <span className="w-1 shrink-0 rounded-full" style={{ backgroundColor: occ.color }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={cn('flex items-center gap-1.5 text-[15px] font-semibold leading-snug', past ? 'text-muted' : 'text-fg')}>
          {occ.kind === 'birthday' && <Cake size={15} className="shrink-0" style={{ color: occ.color }} aria-hidden />}
          <span className="truncate">{occ.title}</span>
          {occ.recurring && occ.kind === 'event' && <Repeat size={12} className="shrink-0 text-subtle" aria-hidden />}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[13px] text-muted">
          {occ.kind === 'birthday' ? (
            <span>{occ.age ? `Turns ${occ.age} 🎉` : 'Happy birthday!'}</span>
          ) : occ.location ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{occ.location}</span>
            </span>
          ) : isMultiDay(occ) ? (
            <span>{spanDays(occ)} days</span>
          ) : null}
        </div>
      </div>
      {trailing}
      {people.length > 0 && occ.kind === 'event' && (
        <div className="shrink-0 self-center">
          <AvatarStack users={people} max={3} size="xs" />
        </div>
      )}
    </button>
  );
}
