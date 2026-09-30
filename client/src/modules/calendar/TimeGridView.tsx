import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addDays, addMinutes, format, isToday, startOfDay } from 'date-fns';
import { Repeat } from 'lucide-react';
import { readableOn } from '../../lib/color';
import { cn } from '../../lib/cn';
import { fmtClock, fmtTimeRange, inAllDayLane, layoutDay, occEnd, occStart, occursOn, sortOccurrences, type Positioned } from './lib';
import { EventPill, occAria } from './parts';
import type { Occurrence } from './types';

interface Props {
  days: Date[];
  events: Occurrence[];
  desktop: boolean;
  onOpen: (o: Occurrence) => void;
  onCreate: (start: Date, allDay?: boolean) => void;
  onDayClick?: (d: Date) => void;
  /** Drag-to-move / resize result (desktop). */
  onMove?: (o: Occurrence, start: Date, end: Date) => void;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const SNAP = 15;

function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

interface Drag {
  id: string;
  mode: 'move' | 'resize';
  x: number;
  y: number;
  colW: number;
  dMin: number;
  dDays: number;
  active: boolean;
}

/** Google-style cascade: events expand into free columns to their right and overlap slightly. */
function geometry(p: Positioned) {
  const unit = 100 / p.cols;
  const left = p.col * unit;
  const natural = p.span * unit;
  const width = p.col + p.span < p.cols ? Math.min(100 - left, natural * 1.7) : natural;
  return { left, width };
}

export function TimeGridView({ days, events, desktop, onOpen, onCreate, onDayClick, onMove }: Props) {
  const hourH = desktop ? 52 : 48;
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const now = useNow();
  const single = days.length === 1;
  const sorted = useMemo(() => sortOccurrences(events), [events]);
  const allDay = useMemo(() => days.map((d) => sorted.filter((o) => inAllDayLane(o) && occursOn(o, d))), [days, sorted]);
  const timed = useMemo(() => days.map((d) => layoutDay(sorted, d)), [days, sorted]);
  const cols = `${desktop ? 56 : 40}px repeat(${days.length}, minmax(0, 1fr))`;
  const [drag, setDrag] = useState<Drag | null>(null);
  const suppressClick = useRef(false);

  // Desktop: scroll the inner grid to now (today) or 7 AM, keeping the hour label fully visible.
  const firstKey = days[0]?.toDateString();
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !desktop) return;
    const hasToday = days.some((d) => isToday(d));
    el.scrollTop = Math.max(0, (hasToday ? Math.min(now.getHours() - 1.5, 17) : 7) * hourH - 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey, hourH, desktop]);
  // Mobile uses the page scroll only (no nested scroller); the empty small hours are skipped
  // (the grid starts at 6 AM unless something is scheduled earlier).
  const startHour = useMemo(() => {
    if (desktop) return 0;
    const earliest = Math.min(...timed.flat().map((p) => Math.floor(p.top / 60)), 24);
    return Math.max(0, Math.min(6, earliest));
  }, [desktop, timed]);
  const hours = HOURS.slice(startHour);
  const off = startHour * hourH;

  const slotFromEvent = (e: React.MouseEvent<HTMLDivElement>, day: Date) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.max(0, Math.min(23.5 * 60, startHour * 60 + Math.floor(((e.clientY - rect.top) / hourH) * 2) * 30));
    return addMinutes(startOfDay(day), minutes);
  };

  const canDrag = (o: Occurrence) => desktop && !!onMove && o.kind === 'event' && o.can_edit && !o.pending;
  const startDrag = (e: React.PointerEvent, o: Occurrence, mode: Drag['mode']) => {
    if (!canDrag(o) || e.button !== 0) return;
    e.stopPropagation();
    const grid = gridRef.current?.getBoundingClientRect();
    const colW = grid ? (grid.width - (desktop ? 56 : 40)) / days.length : 100;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: o.id, mode, x: e.clientX, y: e.clientY, colW, dMin: 0, dDays: 0, active: false });
  };
  const moveDrag = (e: React.PointerEvent, dayIndex: number) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active && Math.hypot(dx, dy) < 5) return;
    const dMin = Math.round(((dy / hourH) * 60) / SNAP) * SNAP;
    const dDays = drag.mode === 'move' ? Math.max(-dayIndex, Math.min(days.length - 1 - dayIndex, Math.round(dx / drag.colW))) : 0;
    setDrag({ ...drag, active: true, dMin, dDays });
  };
  const endDrag = (o: Occurrence) => {
    const d = drag;
    setDrag(null);
    if (!d?.active) return;
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    if (!d.dMin && !d.dDays) return;
    const s = occStart(o);
    const e = occEnd(o);
    if (d.mode === 'move') {
      const ns = addMinutes(addDays(s, d.dDays), d.dMin);
      onMove?.(o, ns, new Date(ns.getTime() + (e.getTime() - s.getTime())));
    } else {
      const ne = addMinutes(e, d.dMin);
      onMove?.(o, s, ne.getTime() - s.getTime() < SNAP * 60_000 ? addMinutes(s, SNAP) : ne);
    }
  };

  return (
    <div className={cn('animate-fade-in rounded-2xl border border-border bg-surface shadow-card', desktop && 'overflow-hidden')}>
      <div
        className={cn('rounded-t-2xl bg-surface', !desktop && 'sticky top-[calc(56px+env(safe-area-inset-top))] z-40 shadow-[0_1px_0_var(--border)]')}
      >
        {/* Day headers */}
        <div className="grid border-b border-border" style={{ gridTemplateColumns: cols }}>
          <div aria-hidden />
          {days.map((d) => {
            const today = isToday(d);
            return (
              <button
                key={d.toISOString()}
                type="button"
                disabled={!onDayClick}
                onClick={() => onDayClick?.(d)}
                aria-label={format(d, 'EEEE, MMMM d')}
                className={cn(
                  'flex min-w-0 flex-col items-center gap-0.5 border-l border-border py-2 transition enabled:hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  single && 'flex-row justify-center gap-2',
                )}
              >
                <span className={cn('text-[11px] font-semibold uppercase tracking-wide', today ? 'text-primary' : 'text-muted')}>{format(d, 'EEE')}</span>
                <span className={cn('flex size-8 items-center justify-center rounded-full text-[15px] font-bold tabular-nums', today ? 'bg-primary-solid text-white' : 'text-fg')}>
                  {d.getDate()}
                </span>
              </button>
            );
          })}
        </div>
        {/* All-day lane */}
        <div className="grid border-b border-border bg-surface-2/40" style={{ gridTemplateColumns: cols }}>
          <div className="flex items-start justify-end px-1.5 pt-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-subtle">{desktop ? 'All day' : 'All'}</div>
          {days.map((d, i) => (
            <div key={d.toISOString()} className="flex min-h-9 min-w-0 cursor-pointer flex-col gap-0.5 border-l border-border p-1" onClick={() => onCreate(startOfDay(d), true)} role="presentation">
              {allDay[i].map((o) => (
                <EventPill key={o.id} occ={o} day={d} onOpen={onOpen} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Hours */}
      <div
        ref={scrollRef}
        className={cn('relative', desktop && 'overflow-y-auto overscroll-contain scrollbar-thin')}
        style={desktop ? { height: 'max(460px, calc(100dvh - var(--shell-chrome) - 190px))' } : undefined}
      >
        <div ref={gridRef} className="grid pt-2" style={{ gridTemplateColumns: cols, height: hourH * (24 - startHour) + 8 }}>
          <div className="relative">
            {hours.map((h) => (
              <div key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] font-medium tabular-nums text-subtle" style={{ top: h * hourH - off }}>
                {h === 0 ? '' : format(new Date(2000, 0, 1, h), desktop ? 'h a' : 'ha').toLowerCase()}
              </div>
            ))}
          </div>
          {days.map((d, i) => {
            const today = isToday(d);
            const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * hourH - off;
            return (
              <div
                key={d.toISOString()}
                className={cn('relative cursor-cell border-l border-border', today && 'bg-primary-soft/25')}
                onClick={(e) => onCreate(slotFromEvent(e, d))}
                role="presentation"
                data-day={format(d, 'yyyy-MM-dd')}
              >
                {hours.map((h) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/70" style={{ top: h * hourH - off }}>
                    <div className="absolute inset-x-0 border-t border-dashed border-border/40" style={{ top: hourH / 2 }} />
                  </div>
                ))}
                {timed[i].map((p) => {
                  const o = p.occ;
                  const { bg } = readableOn(o.color);
                  const dragging = drag?.id === o.id && drag.active;
                  const extra = dragging && drag.mode === 'resize' ? (drag.dMin / 60) * hourH : 0;
                  const top = (p.top / 60) * hourH - off;
                  const height = Math.max(((p.bottom - p.top) / 60) * hourH - 2 + extra, 18);
                  const { left, width } = geometry(p);
                  const short = height < 40;
                  const shownStart = dragging && drag.mode === 'move' ? addMinutes(addDays(occStart(o), drag.dDays), drag.dMin) : occStart(o);
                  const shownEnd = dragging
                    ? drag.mode === 'move' ? new Date(shownStart.getTime() + occEnd(o).getTime() - occStart(o).getTime()) : addMinutes(occEnd(o), drag.dMin)
                    : occEnd(o);
                  const draggable = canDrag(o);
                  return (
                    <div
                      key={o.id}
                      className={cn('absolute', dragging ? 'z-50' : 'hover:z-40 focus-within:z-40')}
                      style={{
                        top: top + 1,
                        height,
                        left: `calc(${left}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                        zIndex: dragging ? 50 : 10 + p.col,
                        transform: dragging && drag.mode === 'move' ? `translate(${drag.dDays * drag.colW}px, ${(drag.dMin / 60) * hourH}px)` : undefined,
                      }}
                    >
                      <button
                        type="button"
                        data-event-id={o.id}
                        aria-label={occAria(o)}
                        aria-roledescription={draggable ? 'draggable event' : undefined}
                        aria-keyshortcuts={draggable ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined}
                        title={draggable ? `${o.title} — drag, or Alt+arrow keys to move` : undefined}
                        onPointerDown={(e) => startDrag(e, o, 'move')}
                        onPointerMove={(e) => moveDrag(e, i)}
                        onPointerUp={() => endDrag(o)}
                        onPointerCancel={() => setDrag(null)}
                        onKeyDown={(e) => {
                          // Keyboard alternative to dragging: Alt+↑/↓ = 15 min, Alt+←/→ = 1 day.
                          if (!e.altKey || !canDrag(o)) return;
                          const step = { ArrowUp: [-SNAP, 0], ArrowDown: [SNAP, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
                          if (!step) return;
                          e.preventDefault();
                          e.stopPropagation();
                          const ns = addMinutes(addDays(occStart(o), step[1]), step[0]);
                          onMove?.(o, ns, new Date(ns.getTime() + occEnd(o).getTime() - occStart(o).getTime()));
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!suppressClick.current) onOpen(o);
                        }}
                        className={cn(
                          'flex size-full flex-col justify-start overflow-hidden rounded-lg border-l-[3px] px-1.5 text-left shadow-xs ring-1 ring-surface transition-shadow hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          short ? 'py-0' : 'py-1',
                          draggable && 'cursor-grab touch-none active:cursor-grabbing',
                          dragging && 'shadow-pop opacity-90',
                          o.pending && 'opacity-60',
                          p.continuesBefore && 'rounded-t-none',
                          p.continuesAfter && 'rounded-b-none',
                        )}
                        style={{ backgroundColor: `color-mix(in oklab, ${o.color} 22%, var(--surface))`, borderLeftColor: bg, color: 'var(--fg)' }}
                      >
                        <div className={cn('flex items-center gap-1 font-semibold leading-tight', desktop ? 'text-[12.5px]' : 'text-[11.5px]', short && 'truncate')}>
                          <span className="truncate">{o.title}</span>
                          {o.recurring && !short && <Repeat size={10} className="shrink-0 opacity-60" aria-hidden />}
                        </div>
                        {!short && (
                          <div className={cn('truncate leading-tight text-muted', desktop ? 'text-[11.5px]' : 'text-[10.5px]')}>
                            {fmtTimeRange(shownStart, shownEnd)}
                            {o.location && height > 58 && <span> · {o.location}</span>}
                          </div>
                        )}
                        {short && !desktop && <span className="sr-only">{fmtClock(occStart(o))}</span>}
                      </button>
                      {draggable && !p.continuesAfter && (
                        <span
                          aria-hidden
                          onPointerDown={(e) => startDrag(e, o, 'resize')}
                          onPointerMove={(e) => moveDrag(e, i)}
                          onPointerUp={() => endDrag(o)}
                          onPointerCancel={() => setDrag(null)}
                          onClick={(e) => e.stopPropagation()}
                          className="absolute inset-x-1 bottom-0 h-2 cursor-ns-resize touch-none rounded-b-lg"
                          data-resize-handle
                        />
                      )}
                    </div>
                  );
                })}
                {today && nowTop >= 0 && (
                  <div className="pointer-events-none absolute inset-x-0 z-[45] flex items-center" style={{ top: nowTop }} aria-hidden>
                    <span className="-ml-1 size-2.5 rounded-full bg-danger" />
                    <span className="h-0.5 flex-1 bg-danger" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
