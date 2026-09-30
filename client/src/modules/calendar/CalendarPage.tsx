import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { addDays, format, isSameDay, isSameMonth, isToday, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import {
  CalendarDays, CalendarPlus, CalendarRange, Check, ChevronLeft, ChevronRight, Keyboard, RefreshCw, Settings2,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, toDate, toDateKey } from '../../lib/format';
import { useIsDesktop, useMediaQuery } from '../../lib/hooks';
import { useLive } from '../../lib/live';
import {
  Avatar, Button, Card, EmptyState, Fab, IconButton, Menu, Modal, PageHeader, SegmentedControl, Skeleton, toast, useConfirm,
} from '../../ui';
import mod from './index';
import { AgendaView } from './AgendaView';
import { EventDetail } from './EventDetail';
import { EventEditor, type EditorState } from './EventEditor';
import { MonthView } from './MonthView';
import { ScopeDialog, type ScopeRequest } from './ScopeDialog';
import { TimeGridView } from './TimeGridView';
import {
  ACCENT, WEEKDAYS_SHORT, weekDays, nextHalfHour, occursOn, ownersOf, rangeTitle, stepCursor, useCalendarMutations, useEvents, usePref, useUpcoming,
  viewRange,
} from './lib';
import type { EventInput, EventSeries, Occurrence, Scope, View } from './types';

const VIEWS: View[] = ['month', 'week', 'day', 'agenda'];
const isView = (v: string | null): v is View => !!v && (VIEWS as string[]).includes(v);

export default function CalendarPage() {
  const { user } = useAuth();
  const desktop = useIsDesktop();
  const wide = useMediaQuery('(min-width: 1600px)'); // sidebar only when month cells stay ≥150px
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const [savedView, setSavedView] = usePref<View>('view', 'month');
  const [weekStartsOn, setWeekStartsOn] = usePref<0 | 1>('week-start', 0);
  const [showBirthdays, setShowBirthdays] = usePref<boolean>('birthdays', true);
  const [hidden, setHidden] = usePref<number[]>('hidden-members', []);
  const [agendaDays, setAgendaDays] = useState(42);

  const view: View = isView(params.get('view')) ? (params.get('view') as View) : savedView;
  const cursor = useMemo(() => toDate(params.get('date')) ?? startOfDay(new Date()), [params]);
  const [selected, setSelected] = useState<Date>(cursor);
  useEffect(() => setSelected((s) => (view === 'month' && isSameMonth(s, cursor) ? s : cursor)), [cursor, view]);

  const navigate = useCallback(
    (next: { view?: View; date?: Date }) => {
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (next.view) n.set('view', next.view);
          if (next.date) n.set('date', toDateKey(next.date));
          return n;
        },
        { replace: true },
      );
      if (next.view) setSavedView(next.view);
    },
    [setParams, setSavedView],
  );

  const { from, to } = useMemo(() => viewRange(view, cursor, weekStartsOn, agendaDays, !desktop), [view, cursor, weekStartsOn, agendaDays, desktop]);
  const query = useEvents(from, to, showBirthdays);
  const upcoming = useUpcoming();
  useLive('calendar');

  const events = useMemo(
    () => (query.data ?? []).filter((o) => {
      const owners = ownersOf(o);
      return !owners.length || owners.some((id) => !hidden.includes(id));
    }),
    [query.data, hidden],
  );

  const { create, update, remove } = useCalendarMutations(user ? { id: user.id, color: user.color } : null);
  const [detail, setDetail] = useState<Occurrence | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [scopeReq, setScopeReq] = useState<ScopeRequest | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const askScope = (kind: 'edit' | 'delete', allowThis: boolean, title: string) =>
    new Promise<Scope | null>((resolve) => setScopeReq({ kind, allowThis, title, resolve }));

  // Deep links: /calendar?event=12&occurrence=...&date=...
  const deepEvent = params.get('event');
  const deepOcc = params.get('occurrence');
  useEffect(() => {
    if (!deepEvent) return;
    let cancelled = false;
    api
      .get<EventSeries>(`/calendar/events/${encodeURIComponent(deepEvent)}${deepOcc ? `?occurrence=${encodeURIComponent(deepOcc)}` : ''}`)
      .then((ev) => {
        if (!cancelled && ev.occurrence) setDetail(ev.occurrence);
      })
      .catch((e) => {
        if (!cancelled) toast.error(errorMessage(e) || 'That event no longer exists');
      })
      .finally(() => {
        if (cancelled) return;
        setParams(
          (p) => {
            const n = new URLSearchParams(p);
            n.delete('event');
            n.delete('occurrence');
            return n;
          },
          { replace: true },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [deepEvent, deepOcc, setParams]);

  // Home quick action: /calendar?new=1[&date=YYYY-MM-DD] opens the editor.
  const wantsNew = params.get('new');
  useEffect(() => {
    if (!wantsNew) return;
    openCreate(toDate(params.get('date')) ?? startOfDay(new Date()));
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete('new');
        return n;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsNew]);

  // Keep an open detail sheet in sync with live data (someone else edited it) — or close it if it vanished.
  useEffect(() => {
    if (!detail || !query.data || query.isPlaceholderData || detail.kind !== 'event') return;
    const fresh = query.data.find((o) => o.id === detail.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(detail)) setDetail(fresh);
  }, [query.data, query.isPlaceholderData, detail]);

  const openCreate = useCallback((day: Date, allDay = false, exact = false) => {
    let start: Date;
    if (allDay) start = startOfDay(day);
    else if (exact) start = day;
    else if (isToday(day)) start = nextHalfHour();
    else {
      start = startOfDay(day);
      start.setHours(9);
    }
    setEditor({ mode: 'create', start, allDay });
  }, []);

  const onSubmit = async (input: EventInput, meta: { rruleChanged: boolean; original?: Occurrence; changed: Partial<EventInput> }): Promise<boolean> => {
    const o = meta.original;
    try {
      if (!o) {
        const done = create.mutateAsync(input);
        setEditor(null);
        await done;
        toast.success(`${input.title} added`, { description: format(toDate(input.start)!, input.all_day ? 'EEEE, MMM d' : 'EEEE, MMM d · h:mm a') });
        return true;
      }
      const payload: Partial<EventInput> = { ...meta.changed };
      if (!Object.keys(payload).length) {
        toast.info('No changes to save');
        return true;
      }
      let scope: Scope = 'all';
      if (o.recurring) {
        const s = await askScope('edit', !meta.rruleChanged, o.title);
        if (!s) return false;
        scope = s;
      }
      if (scope === 'this') delete payload.rrule;
      setEditor(null);
      setDetail(null);
      const res = await update.mutateAsync({ occ: o, input: payload, scope });
      if (res.dropped_exceptions) {
        toast.warning('Changes saved', {
          description: `${res.dropped_exceptions} individually changed day${res.dropped_exceptions === 1 ? '' : 's'} no longer fit the new pattern and were reset.`,
        });
      } else toast.success('Changes saved');
      return true;
    } catch {
      return false; // toast shown by the mutation
    }
  };

  const onDelete = async (o: Occurrence) => {
    let scope: Scope = 'all';
    if (o.recurring) {
      const s = await askScope('delete', true, o.title);
      if (!s) return;
      scope = s;
    } else {
      const ok = await confirm({ title: `Delete “${o.title}”?`, message: 'It will be removed from everyone’s calendar.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
    }
    setDetail(null);
    remove.mutate({ occ: o, scope }, { onSuccess: () => toast.success(scope === 'this' ? 'Event removed for that day' : 'Event deleted') });
  };

  // Drag-to-move / resize in week & day views.
  const onMove = async (o: Occurrence, start: Date, end: Date) => {
    let scope: Scope = 'all';
    if (o.recurring) {
      const s = await askScope('edit', true, o.title);
      if (!s) return;
      scope = s;
    }
    update.mutate(
      // No tz: the series keeps its own zone and the server shifts it by the delta in that zone.
      { occ: o, input: { all_day: false, start: start.toISOString(), end: end.toISOString() }, scope },
      { onSuccess: () => toast.success(`${o.title} moved`, { description: format(start, 'EEEE, MMM d · h:mm a') }) },
    );
  };

  const go = (dir: 1 | -1) => navigate({ date: stepCursor(view, cursor, dir, !desktop) });
  const goToday = () => {
    const t = startOfDay(new Date());
    setSelected(t);
    navigate({ date: t });
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const k = e.key.toLowerCase();
      const map: Record<string, () => void> = {
        t: goToday,
        arrowleft: () => go(-1),
        arrowright: () => go(1),
        j: () => go(1),
        k: () => go(-1),
        m: () => navigate({ view: 'month' }),
        w: () => navigate({ view: 'week' }),
        d: () => navigate({ view: 'day' }),
        a: () => navigate({ view: 'agenda' }),
        n: () => openCreate(selected),
        c: () => openCreate(selected),
        '?': () => setHelpOpen(true),
      };
      const fn = map[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Swipe left/right to page through time on touch screens.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s || desktop) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) go(dx < 0 ? 1 : -1);
  };

  const todayCount = (upcoming.data ?? []).filter((o) => occursOn(o, new Date())).length;
  const days = useMemo(() => {
    if (view === 'week') return Array.from({ length: weekDays(!desktop) }, (_, i) => addDays(desktop ? startOfWeek(cursor, { weekStartsOn }) : startOfDay(cursor), i));
    return [startOfDay(cursor)];
  }, [view, cursor, weekStartsOn, desktop]);

  const viewOptions = [
    { value: 'month' as View, label: 'Month' },
    { value: 'week' as View, label: desktop ? 'Week' : '3 days' },
    { value: 'day' as View, label: 'Day' },
    { value: 'agenda' as View, label: 'Agenda' },
  ];

  const settingsMenu = (
    <Menu
      label="Calendar settings"
      trigger={() => (
        <span className="inline-flex size-10 items-center justify-center rounded-xl border border-border bg-surface text-muted shadow-xs transition hover:bg-surface-2 hover:text-fg">
          <Settings2 size={18} />
        </span>
      )}
      items={[
        { label: 'Week starts on Monday', icon: weekStartsOn === 1 ? Check : CalendarRange, onSelect: () => setWeekStartsOn(weekStartsOn === 1 ? 0 : 1), hint: weekStartsOn === 1 ? 'On' : 'Off' },
        { label: 'Show birthdays', icon: showBirthdays ? Check : CalendarRange, onSelect: () => setShowBirthdays(!showBirthdays), hint: showBirthdays ? 'On' : 'Off' },
        'divider',
        { label: 'Keyboard shortcuts', icon: Keyboard, onSelect: () => setHelpOpen(true), hint: '?' },
      ]}
    />
  );

  const toolbar = (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-3">
      <div className="flex min-w-[18rem] flex-1 items-center gap-1.5">
        <IconButton icon={ChevronLeft} label={`Previous ${view === 'agenda' ? 'two weeks' : view}`} onClick={() => go(-1)} variant="secondary" size="sm" />
        <IconButton icon={ChevronRight} label={`Next ${view === 'agenda' ? 'two weeks' : view}`} onClick={() => go(1)} variant="secondary" size="sm" />
        <h2 className="ml-1.5 min-w-0 truncate whitespace-nowrap text-lg font-bold tracking-tight text-fg sm:text-xl" aria-live="polite" data-testid="cal-title">
          {rangeTitle(view, cursor, weekStartsOn, !desktop)}
        </h2>
        {query.isFetching && !query.isPending && <RefreshCw size={14} className="ml-1 shrink-0 animate-spin text-subtle" aria-label="Updating" />}
        <Button variant="secondary" size="sm" onClick={goToday} className="ml-auto shrink-0" disabled={isSameDay(cursor, new Date()) && view !== 'month'}>
          Today
        </Button>
      </div>
      <SegmentedControl aria-label="Calendar view" options={viewOptions} value={view} onChange={(v) => navigate({ view: v })} block={!desktop} size={desktop ? 'md' : 'sm'} />
    </div>
  );

  const loadingSkeleton = (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface p-3 shadow-card" aria-busy="true" aria-label="Loading calendar">
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: desktop ? 35 : 35 }, (_, i) => (
          <Skeleton key={i} className={desktop ? 'h-24 rounded-xl' : 'h-11 rounded-lg'} />
        ))}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (query.isPending) body = loadingSkeleton;
  else if (query.isError && !query.data) {
    body = (
      <EmptyState
        icon={CalendarDays}
        accent={ACCENT}
        title="Couldn't load the calendar"
        description={errorMessage(query.error) || 'Check your connection and try again.'}
        action={<Button icon={RefreshCw} onClick={() => query.refetch()}>Try again</Button>}
      />
    );
  } else if (view === 'month') {
    body = (
      <MonthView
        cursor={cursor}
        from={from}
        events={events}
        weekStartsOn={weekStartsOn}
        selected={selected}
        desktop={desktop}
        onSelectDay={(d) => {
          setSelected(d);
          if (!isSameMonth(d, cursor)) navigate({ date: startOfMonth(d) });
        }}
        onOpen={setDetail}
        onCreate={(d) => openCreate(d)}
        onDayView={(d) => navigate({ view: 'day', date: d })}
      />
    );
  } else if (view === 'agenda') {
    body = (
      <AgendaView
        from={from}
        days={agendaDays}
        events={events}
        onOpen={setDetail}
        onCreate={(d) => openCreate(d)}
        onLoadMore={() => setAgendaDays((n) => Math.min(n + 42, 364))}
        loadingMore={query.isFetching && query.isPlaceholderData}
        onClearFilter={hidden.length ? () => setHidden([]) : undefined}
      />
    );
  } else {
    body = (
      <TimeGridView
        days={days}
        events={events}
        desktop={desktop}
        onOpen={setDetail}
        onCreate={(start, allDay) => openCreate(start, !!allDay, !allDay)}
        onDayClick={view === 'week' ? (d) => navigate({ view: 'day', date: d }) : undefined}
        onMove={onMove}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title={mod.label}
        subtitle={todayCount ? `${format(new Date(), 'EEEE, MMMM d')} · ${todayCount} today` : format(new Date(), 'EEEE, MMMM d')}
        icon={mod.icon}
        accent={mod.accent}
        actions={
          <>
            {settingsMenu}
            {desktop && (
              <Button icon={CalendarPlus} onClick={() => openCreate(selected)}>
                New event
              </Button>
            )}
          </>
        }
      />

      <div className={cn('grid gap-6 pb-20 lg:pb-0', wide && 'grid-cols-[240px_minmax(0,1fr)]')}>
        {wide && (
          <aside className="space-y-4" aria-label="Calendar sidebar">
            <MiniMonth
              cursor={cursor}
              selected={selected}
              weekStartsOn={weekStartsOn}
              events={view === 'month' ? events : []}
              onPick={(d) => {
                setSelected(d);
                navigate({ date: d });
              }}
            />
            <Card padding="sm">
              <MemberFilter hidden={hidden} setHidden={setHidden} />
            </Card>
            <Card padding="sm">
              <h3 className="px-1.5 pb-1 pt-1 text-[13px] font-bold uppercase tracking-wide text-muted">Coming up</h3>
              {upcoming.isPending ? (
                <div className="space-y-2 p-1.5">
                  <Skeleton className="h-10 rounded-xl" />
                  <Skeleton className="h-10 rounded-xl" />
                </div>
              ) : upcoming.data?.length ? (
                <div className="-mx-1">
                  {upcoming.data.slice(0, 5).map((o) => (
                    <UpcomingItem key={o.id} occ={o} onOpen={setDetail} />
                  ))}
                </div>
              ) : (
                <p className="px-1.5 pb-2 text-sm text-muted">Nothing in the next two weeks.</p>
              )}
            </Card>
          </aside>
        )}

        <section className="min-w-0" aria-label="Calendar" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {toolbar}
          {!wide && (
            <div className="-mt-1 mb-4">
              <MemberFilter hidden={hidden} setHidden={setHidden} compact />
            </div>
          )}
          {body}
        </section>
      </div>

      <Fab label="New event" icon={CalendarPlus} accent={ACCENT} onClick={() => openCreate(selected)} />

      <EventDetail
        occ={detail}
        onClose={() => setDetail(null)}
        onEdit={(o) => {
          setDetail(null);
          setEditor({ mode: 'edit', occ: o });
        }}
        onDuplicate={(o) => {
          setDetail(null);
          setEditor({ mode: 'duplicate', occ: o });
        }}
        onDelete={onDelete}
      />
      <EventEditor state={editor} onClose={() => setEditor(null)} onSubmit={onSubmit} />
      <ScopeDialog req={scopeReq} onDone={() => setScopeReq(null)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function UpcomingItem({ occ, onOpen }: { occ: Occurrence; onOpen: (o: Occurrence) => void }) {
  const s = toDate(occ.start)!;
  return (
    <button
      type="button"
      onClick={() => onOpen(occ)}
      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: occ.color }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-fg">{occ.title}</span>
        <span className="block truncate text-[12px] text-muted">
          {isToday(s) ? 'Today' : format(s, 'EEE, MMM d')}
          {!occ.all_day && ` · ${format(s, s.getMinutes() ? 'h:mm a' : 'h a')}`}
        </span>
      </span>
    </button>
  );
}

function MemberFilter({ hidden, setHidden, compact }: { hidden: number[]; setHidden: (v: number[]) => void; compact?: boolean }) {
  const { members } = useAuth();
  const toggle = (id: number) => setHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
  if (compact) {
    return (
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none" role="group" aria-label="Show events for">
        {members.map((m) => {
          const on = !hidden.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(m.id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-[13px] font-medium transition active:scale-95',
                on ? 'text-fg' : 'border-border bg-surface text-subtle opacity-70',
              )}
              style={on ? { borderColor: m.color, backgroundColor: `color-mix(in oklab, ${m.color} 13%, var(--surface))` } : undefined}
            >
              <span className={cn(!on && 'grayscale')}>
                <Avatar user={m} size="xs" title="" />
              </span>
              <span className={cn(!on && 'line-through')}>{m.nickname || firstName(m.name)}</span>
            </button>
          );
        })}
        {hidden.length > 0 && (
          <button type="button" onClick={() => setHidden([])} className="shrink-0 rounded-full px-3 text-[13px] font-semibold text-primary hover:underline">
            Show all
          </button>
        )}
      </div>
    );
  }
  return (
    <div role="group" aria-label="Show events for">
      <div className="flex items-center justify-between px-1.5 pb-1 pt-1">
        <h3 className="text-[13px] font-bold uppercase tracking-wide text-muted">Family</h3>
        {hidden.length > 0 && (
          <button type="button" onClick={() => setHidden([])} className="text-[12px] font-semibold text-primary hover:underline">
            Show all
          </button>
        )}
      </div>
      {members.map((m) => {
        const on = !hidden.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => toggle(m.id)}
            className="flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className="flex size-[18px] shrink-0 items-center justify-center rounded-md border-2 transition"
              style={{ borderColor: m.color, backgroundColor: on ? m.color : 'transparent' }}
              aria-hidden
            >
              {on && <Check size={12} strokeWidth={3.5} className="text-white drop-shadow-sm" />}
            </span>
            <Avatar user={m} size="xs" title="" />
            <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', on ? 'text-fg' : 'text-subtle')}>{m.nickname || firstName(m.name)}</span>
          </button>
        );
      })}
    </div>
  );
}

function MiniMonth({
  cursor, selected, weekStartsOn, events, onPick,
}: { cursor: Date; selected: Date; weekStartsOn: 0 | 1; events: Occurrence[]; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(() => startOfMonth(cursor));
  useEffect(() => setMonth(startOfMonth(cursor)), [cursor]);
  const start = startOfWeek(month, { weekStartsOn });
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const busy = new Set(events.map((o) => toDateKey(o.start)));
  return (
    <Card padding="sm">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-sm font-bold text-fg">{format(month, 'MMMM yyyy')}</span>
        <div className="flex">
          <IconButton icon={ChevronLeft} label="Previous month" size="sm" onClick={() => setMonth(startOfMonth(addDays(month, -1)))} />
          <IconButton icon={ChevronRight} label="Next month" size="sm" onClick={() => setMonth(startOfMonth(addDays(month, 32)))} />
        </div>
      </div>
      <div className="grid grid-cols-7 text-center">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className="py-1 text-[10px] font-semibold uppercase text-subtle">
            {WEEKDAYS_SHORT[(i + weekStartsOn) % 7][0]}
          </span>
        ))}
        {days.map((d) => {
          const inMonth = isSameMonth(d, month);
          const sel = isSameDay(d, selected);
          const today = isToday(d);
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPick(d)}
              aria-label={format(d, 'EEEE, MMMM d')}
              aria-current={today ? 'date' : undefined}
              className={cn(
                'relative mx-auto flex size-8 items-center justify-center rounded-full text-[12.5px] tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                sel ? 'bg-primary-solid font-bold text-white' : today ? 'font-bold text-primary hover:bg-surface-2' : inMonth ? 'text-fg hover:bg-surface-2' : 'text-subtle hover:bg-surface-2',
              )}
            >
              {d.getDate()}
              {busy.has(toDateKey(d)) && !sel && <span className="absolute bottom-1 size-1 rounded-full bg-primary" aria-hidden />}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['T', 'Jump to today'],
    ['← / →  or  K / J', 'Previous / next'],
    ['M  W  D  A', 'Month, week, day, agenda'],
    ['N', 'New event'],
    ['Alt + arrows', 'Move the focused event (week/day)'],
    ['?', 'Show this help'],
  ];
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Keyboard shortcuts">
      <dl className="divide-y divide-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-sm text-fg">{v}</dt>
            <dd>
              <kbd className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[12px] text-muted">{k}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
