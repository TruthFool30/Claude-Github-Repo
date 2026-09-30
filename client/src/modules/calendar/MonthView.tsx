import { useMemo, useRef, useState } from 'react';
import { addDays, differenceInCalendarDays, format, isSameDay, isSameMonth, isToday, startOfDay } from 'date-fns';
import { Cake, Plus } from 'lucide-react';
import { readableOn } from '../../lib/color';
import { cn } from '../../lib/cn';
import { Button, EmptyState, Popover } from '../../ui';
import { ACCENT, fmtClock, occEnd, occStart, occursOn, sortOccurrences, spanDays, WEEKDAYS_SHORT } from './lib';
import { occAria, OccurrenceRow } from './parts';
import type { Occurrence } from './types';

interface Props {
  cursor: Date;
  from: Date;
  events: Occurrence[];
  weekStartsOn: 0 | 1;
  selected: Date;
  desktop: boolean;
  onSelectDay: (d: Date) => void;
  onOpen: (o: Occurrence) => void;
  onCreate: (d: Date) => void;
  onDayView: (d: Date) => void;
}

const LANE = 24; // px per line (bars and chips)
const HEAD = 32; // day-number row
const LINES = 4; // visible lines per cell before "+N more"

/** "7:45a" / "7p" */
const shortTime = (d: Date) => fmtClock(d).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p');

interface Bar {
  occ: Occurrence;
  col: number;
  span: number;
  lane: number;
  cutStart: boolean;
  cutEnd: boolean;
}

/** Lay multi-day events out as bars across one week row (greedy lanes, longest first). */
function layoutBars(week: Date[], multi: Occurrence[]): Bar[] {
  const w0 = startOfDay(week[0]);
  const bars: Bar[] = [];
  const items = multi
    .filter((o) => week.some((d) => occursOn(o, d)))
    .map((o) => {
      const s = startOfDay(occStart(o));
      const eIncl = startOfDay(new Date(Math.max(occEnd(o).getTime() - 1, occStart(o).getTime())));
      const a = Math.max(0, differenceInCalendarDays(s, w0));
      const b = Math.min(6, differenceInCalendarDays(eIncl, w0));
      return { occ: o, col: a, span: b - a + 1, cutStart: s < w0, cutEnd: differenceInCalendarDays(eIncl, w0) > 6 };
    })
    .sort((x, y) => x.col - y.col || y.span - x.span);
  const lanes: number[][] = []; // lanes[lane] = occupied columns
  for (const it of items) {
    let lane = 0;
    while (lanes[lane]?.some((c) => c >= it.col && c < it.col + it.span)) lane++;
    (lanes[lane] ??= []).push(...Array.from({ length: it.span }, (_, i) => it.col + i));
    bars.push({ ...it, lane });
  }
  return bars;
}

export function MonthView({ cursor, from, events, weekStartsOn, selected, desktop, onSelectDay, onOpen, onCreate, onDayView }: Props) {
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(from, i)), [from]);
  const sorted = useMemo(() => sortOccurrences(events), [events]);
  const byDay = useMemo(() => days.map((d) => sorted.filter((o) => occursOn(o, d))), [days, sorted]);
  const weeks = !isSameMonth(days[35], cursor) ? 5 : 6;
  const heads = Array.from({ length: 7 }, (_, i) => WEEKDAYS_SHORT[(i + weekStartsOn) % 7]);
  const selectedIdx = days.findIndex((d) => isSameDay(d, selected));
  const selectedList = selectedIdx >= 0 ? byDay[selectedIdx] : [];
  const [more, setMore] = useState<Date | null>(null);
  const moreAnchor = useRef<HTMLElement | null>(null);
  const moreList = more ? byDay[days.findIndex((d) => isSameDay(d, more))] ?? [] : [];

  return (
    <div className="animate-fade-in">
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card" role="grid" aria-label={format(cursor, 'MMMM yyyy')}>
        <div className="grid grid-cols-7 border-b border-border bg-surface-2/50" role="row">
          {heads.map((h) => (
            <div key={h} role="columnheader" className="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted">
              {desktop ? h : h[0]}
            </div>
          ))}
        </div>
        {Array.from({ length: weeks }, (_, w) => {
          const week = days.slice(w * 7, w * 7 + 7);
          if (!desktop) {
            return (
              <div key={w} className="grid grid-cols-7" role="row">
                {week.map((d, i) => {
                  const list = byDay[w * 7 + i];
                  const inMonth = isSameMonth(d, cursor);
                  const today = isToday(d);
                  const isSel = isSameDay(d, selected);
                  return (
                    <button
                      key={i}
                      type="button"
                      role="gridcell"
                      aria-selected={isSel}
                      aria-label={`${format(d, 'EEEE, MMMM d')}${list.length ? `, ${list.length} event${list.length === 1 ? '' : 's'}` : ', no events'}`}
                      onClick={() => onSelectDay(d)}
                      onDoubleClick={() => onCreate(d)}
                      className={cn(
                        'relative flex h-[54px] flex-col items-center gap-1 border-border pt-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        i > 0 && 'border-l',
                        w > 0 && 'border-t',
                        !inMonth && 'bg-surface-2/40',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-7 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums transition',
                          isSel && today && 'bg-primary-solid text-white',
                          isSel && !today && 'bg-fg text-bg',
                          !isSel && (today ? 'font-bold text-primary' : inMonth ? 'text-fg' : 'text-subtle'),
                        )}
                      >
                        {d.getDate()}
                      </span>
                      <span className="flex h-1.5 items-center gap-[3px]" aria-hidden>
                        {list.slice(0, 3).map((o) => (
                          <span key={o.id} className="size-1.5 rounded-full" style={{ backgroundColor: o.color }} />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          }

          // Desktop: multi-day events are bars spanning the row; single-day ones are chips per cell.
          const multi = byDay.slice(w * 7, w * 7 + 7).flat().filter((o, i, arr) => spanDays(o) > 1 && arr.findIndex((x) => x.id === o.id) === i);
          const bars = layoutBars(week, multi);
          const shownBars = bars.filter((b) => b.lane < LINES - 1);
          const laneUse = week.map((_, c) => {
            const lanesHere = shownBars.filter((b) => c >= b.col && c < b.col + b.span).map((b) => b.lane);
            return lanesHere.length ? Math.max(...lanesHere) + 1 : 0;
          });
          return (
            <div key={w} className={cn('relative grid grid-cols-7', w > 0 && 'border-t border-border')} role="row">
              {week.map((d, c) => {
                const idx = w * 7 + c;
                const all = byDay[idx];
                const singles = all.filter((o) => spanDays(o) <= 1);
                const hiddenBars = bars.filter((b) => b.lane >= LINES - 1 && c >= b.col && c < b.col + b.span).length;
                const room = LINES - laneUse[c];
                const overflow = singles.length > room || hiddenBars > 0;
                const chips = overflow ? singles.slice(0, Math.max(0, room - 1)) : singles;
                const hidden = singles.length - chips.length + hiddenBars;
                const inMonth = isSameMonth(d, cursor);
                const today = isToday(d);
                return (
                  <div
                    key={c}
                    role="gridcell"
                    aria-label={`${format(d, 'EEEE, MMMM d')}${all.length ? `, ${all.length} event${all.length === 1 ? '' : 's'}` : ', no events'}`}
                    onClick={() => onCreate(d)}
                    className={cn(
                      'group relative flex min-w-0 cursor-pointer flex-col border-border px-1 pb-1.5 transition-colors hover:bg-surface-2/60',
                      c > 0 && 'border-l',
                      !inMonth && 'bg-surface-2/40',
                    )}
                    style={{ minHeight: HEAD + LINES * LANE + 8 }}
                  >
                    <div className="flex items-center justify-between" style={{ height: HEAD }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDayView(d);
                        }}
                        aria-label={`Open ${format(d, 'EEEE, MMMM d')}`}
                        className={cn(
                          'flex h-7 min-w-7 items-center justify-center whitespace-nowrap rounded-full px-1.5 text-[13px] font-semibold tabular-nums transition hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          today ? 'bg-primary-solid text-white hover:bg-primary-solid' : inMonth ? 'text-fg' : 'text-subtle',
                        )}
                      >
                        {d.getDate() === 1 && !today ? format(d, 'MMM d') : d.getDate()}
                      </button>
                      <button
                        type="button"
                        aria-label={`Add event on ${format(d, 'MMMM d')}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCreate(d);
                        }}
                        className="mr-0.5 flex size-6 items-center justify-center rounded-lg text-muted opacity-0 transition hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <div style={{ height: laneUse[c] * LANE }} aria-hidden />
                    {chips.map((o) => (
                      <DayChip key={o.id} occ={o} onOpen={onOpen} wrap={!overflow && singles.length + laneUse[c] <= 2} />
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          moreAnchor.current = e.currentTarget;
                          setMore((m) => (m && isSameDay(m, d) ? null : d));
                        }}
                        aria-haspopup="dialog"
                        aria-expanded={!!more && isSameDay(more, d)}
                        className="mt-px h-[22px] rounded-md px-1.5 text-left text-[12px] font-semibold text-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        +{hidden} more
                      </button>
                    )}
                  </div>
                );
              })}
              {/* Spanning bars */}
              <div className="pointer-events-none absolute inset-x-0" style={{ top: HEAD }}>
                {shownBars.map((b) => (
                  <SpanBar key={`${b.occ.id}-${w}`} bar={b} onOpen={onOpen} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Popover open={!!more} onClose={() => setMore(null)} anchorRef={moreAnchor} align="start" className="w-[20rem] p-2" role="dialog" aria-label={more ? `Events on ${format(more, 'MMMM d')}` : undefined}>
        {more && (
          <div>
            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{format(more, 'EEEE')}</div>
                <div className="text-lg font-bold text-fg">{format(more, 'MMMM d')}</div>
              </div>
              <Button
                size="sm"
                variant="soft"
                icon={Plus}
                onClick={() => {
                  const d = more;
                  setMore(null);
                  onCreate(d);
                }}
              >
                Add
              </Button>
            </div>
            <div className="max-h-[22rem] overflow-y-auto scrollbar-thin">
              {moreList.map((o) => (
                <OccurrenceRow
                  key={o.id}
                  occ={o}
                  onOpen={(x) => {
                    setMore(null);
                    onOpen(x);
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </Popover>

      {!desktop && (
        <section className="mt-5" aria-label={`Events on ${format(selected, 'MMMM d')}`}>
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="text-[15px] font-bold text-fg">
              {isToday(selected) ? 'Today' : format(selected, 'EEEE')}
              <span className="ml-2 font-medium text-muted">{format(selected, 'MMM d')}</span>
            </h2>
            <Button size="sm" variant="soft" icon={Plus} onClick={() => onCreate(selected)}>
              Add
            </Button>
          </div>
          {selectedList.length ? (
            <div className="rounded-2xl border border-border bg-surface p-1.5 shadow-card">
              {selectedList.map((o) => (
                <OccurrenceRow key={o.id} occ={o} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              accent={ACCENT}
              title="Nothing planned"
              description="A free day! Tap Add to put something on the family calendar."
              className="rounded-2xl border border-dashed border-border"
            />
          )}
        </section>
      )}
    </div>
  );
}

/** Single-day chip: all-day = filled; timed = color dot + start time + title. */
function DayChip({ occ, onOpen, wrap }: { occ: Occurrence; onOpen: (o: Occurrence) => void; wrap?: boolean }) {
  const solid = occ.all_day;
  const { bg, fg } = readableOn(occ.color);
  return (
    <button
      type="button"
      data-event-id={occ.id}
      aria-label={occAria(occ)}
      title={occ.title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(occ);
      }}
      className={cn(
        'mt-px flex w-full min-w-0 gap-1 rounded-md px-1 text-left text-[12px] transition',
        wrap ? 'min-h-[22px] items-start py-[4px] leading-[14px]' : 'h-[22px] items-center leading-none',
        'transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        solid ? 'font-semibold hover:brightness-110' : 'text-fg hover:bg-surface-3',
        occ.pending && 'opacity-60',
      )}
      style={solid ? { backgroundColor: bg, color: fg } : undefined}
    >
      {occ.kind === 'birthday' ? <Cake size={12} className="shrink-0" aria-hidden /> : !solid && <span className={cn('size-2 shrink-0 rounded-full', wrap && 'mt-[3px]')} style={{ backgroundColor: occ.color }} aria-hidden />}
      {wrap ? (
        // One text block so a second line flows back under the time (left-aligned, no hanging indent).
        <span className="block max-h-[28px] min-w-0 overflow-hidden break-words text-left">
          {!solid && <span className="mr-1 font-medium tabular-nums text-muted">{shortTime(occStart(occ))}</span>}
          <span className="font-semibold">{occ.title}</span>
        </span>
      ) : (
        <>
          {!solid && <span className="shrink-0 font-medium tabular-nums text-muted">{shortTime(occStart(occ))}</span>}
          <span className="min-w-0 truncate font-semibold">{occ.title}</span>
        </>
      )}
    </button>
  );
}

/** Bar spanning several days in one week row (continues with square ends across rows). */
function SpanBar({ bar, onOpen }: { bar: Bar; onOpen: (o: Occurrence) => void }) {
  const o = bar.occ;
  const { bg, fg } = readableOn(o.color);
  const timed = !o.all_day;
  return (
    <button
      type="button"
      data-event-id={o.id}
      aria-label={occAria(o)}
      title={o.title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(o);
      }}
      className={cn(
        'pointer-events-auto absolute flex h-[22px] min-w-0 items-center gap-1.5 truncate px-2 text-left text-[12px] font-semibold leading-none shadow-xs transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        bar.cutStart ? 'rounded-l-none' : 'rounded-l-md',
        bar.cutEnd ? 'rounded-r-none' : 'rounded-r-md',
        o.pending && 'opacity-60',
      )}
      style={{
        top: bar.lane * LANE + 1,
        left: `calc(${(bar.col / 7) * 100}% + ${bar.cutStart ? 0 : 4}px)`,
        width: `calc(${(bar.span / 7) * 100}% - ${(bar.cutStart ? 0 : 4) + (bar.cutEnd ? 0 : 4)}px)`,
        ...(timed
          ? { backgroundColor: `color-mix(in oklab, ${o.color} 20%, var(--surface))`, color: 'var(--fg)', boxShadow: `inset 3px 0 0 ${bg}` }
          : { backgroundColor: bg, color: fg }),
      }}
    >
      {bar.cutStart && <span aria-hidden>←</span>}
      {timed && !bar.cutStart && <span className="shrink-0 font-medium tabular-nums opacity-75">{shortTime(occStart(o))}</span>}
      <span className="truncate">{o.title}</span>
      {bar.cutEnd && <span className="ml-auto shrink-0" aria-hidden>→</span>}
    </button>
  );
}
