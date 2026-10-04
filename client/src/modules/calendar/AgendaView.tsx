import { useMemo } from 'react';
import { addDays, differenceInCalendarDays, format, isToday, isTomorrow, startOfDay } from 'date-fns';
import { CalendarPlus, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button, EmptyState } from '../../ui';
import { ACCENT, occStart, occursOn, sortOccurrences } from './lib';
import { OccurrenceRow } from './parts';
import type { Occurrence } from './types';

interface Props {
  from: Date;
  days: number;
  events: Occurrence[];
  onOpen: (o: Occurrence) => void;
  onCreate: (d: Date) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  /** Set when the member filter hides people — offers to show everyone. */
  onClearFilter?: () => void;
}

export function AgendaView({ from, days, events, onOpen, onCreate, onLoadMore, loadingMore, onClearFilter }: Props) {
  const groups = useMemo(() => {
    const sorted = sortOccurrences(events);
    const out: Array<{ day: Date; items: Occurrence[] }> = [];
    for (let i = 0; i < days; i++) {
      const day = addDays(startOfDay(from), i);
      // Multi-day items appear on their first visible day only, to keep the list scannable.
      const items = sorted.filter((o) => occursOn(o, day) && (i === 0 || startOfDay(occStart(o)).getTime() >= day.getTime()));
      if (items.length) out.push({ day, items });
    }
    return out;
  }, [events, from, days]);

  if (!groups.length) {
    return (
      <EmptyState
        icon={CalendarPlus}
        accent={ACCENT}
        title="Nothing on the calendar"
        description={onClearFilter ? 'Some family members are hidden by the filter.' : `No events in the next ${days} days. Plan something fun for the family!`}
        action={
          onClearFilter ? (
            <Button variant="soft" onClick={onClearFilter}>Show everyone</Button>
          ) : (
            <Button icon={CalendarPlus} onClick={() => onCreate(from)}>Add an event</Button>
          )
        }
        className="rounded-2xl border border-dashed border-border bg-surface"
      />
    );
  }

  return (
    <div className="animate-fade-in space-y-4">
      {groups.map(({ day, items }) => {
        const today = isToday(day);
        const rel = today ? 'Today' : isTomorrow(day) ? 'Tomorrow' : differenceInCalendarDays(day, new Date()) < 7 && day > new Date() ? format(day, 'EEEE') : null;
        return (
          <section key={day.toISOString()} aria-label={format(day, 'EEEE, MMMM d')} className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-4">
            <header className="sticky top-[calc(56px+env(safe-area-inset-top))] z-10 flex items-center gap-3 bg-bg/90 py-1 backdrop-blur sm:static sm:block sm:bg-transparent sm:pt-3 sm:backdrop-blur-none lg:top-0">
              <div className={cn('flex size-11 shrink-0 flex-col items-center justify-center rounded-2xl leading-none sm:size-14', today ? 'bg-primary-solid text-white' : 'bg-surface text-fg shadow-card ring-1 ring-border')}>
                <span className={cn('text-[10px] font-bold uppercase tracking-wide', today ? 'text-white/85' : 'text-muted')}>{format(day, 'EEE')}</span>
                <span className="mt-0.5 text-lg font-bold tabular-nums sm:text-xl">{day.getDate()}</span>
              </div>
              <div className="sm:mt-2">
                <div className="text-[14px] font-bold text-fg sm:text-[13px]">{rel ?? format(day, 'MMMM d')}</div>
                <div className="text-[12px] text-muted sm:hidden">{rel ? format(day, 'MMMM d') : format(day, 'EEEE')}</div>
              </div>
            </header>
            <div className="rounded-2xl border border-border bg-surface p-1.5 shadow-card">
              {items.map((o) => (
                <OccurrenceRow key={o.id} occ={o} onOpen={onOpen} />
              ))}
            </div>
          </section>
        );
      })}
      <div className="flex justify-center pt-2">
        <Button variant="secondary" icon={ChevronDown} loading={loadingMore} onClick={onLoadMore}>
          Show more
        </Button>
      </div>
    </div>
  );
}
