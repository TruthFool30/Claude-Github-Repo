import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, ChefHat, ChevronLeft, ChevronRight, Clock, Copy, Eraser, MoreHorizontal, Plus, Replace, ShoppingCart, Sparkles } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtDate, plural, toDate, toDateKey } from '../../lib/format';
import { useIsDesktop } from '../../lib/hooks';
import type { Member } from '../../lib/types';
import { Avatar, Button, Card, Fab, IconButton, Menu, Skeleton, toast, useConfirm } from '../../ui';
import { keys, usePlan, useRecipes, type PlanEntry, type PlanResponse, type Slot } from './api';
import { PlanEntryDialog, type PlanDialogState } from './PlanEntryDialog';
import { RecipeArt } from './RecipeArt';
import { ShoppingDialog } from './ShoppingDialog';
import { ACCENT_SOLID, SLOTS, fmtMinutes, relativeWeek, shiftDays, slotMeta, weekDays, weekLabel, weekStart } from './utils';

export function Planner() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('week');
  const start = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && toDate(raw) ? weekStart(raw) : weekStart();
  const { members, role } = useAuth();
  const isDesktop = useIsDesktop();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const planQ = usePlan(start);
  const [dialog, setDialog] = useState<PlanDialogState | null>(null);
  const [shopOpen, setShopOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const today = toDateKey();
  const days = weekDays(start);
  const thisWeek = weekStart();
  const isGrownUp = role !== 'child';

  const entries = useMemo(() => (planQ.data?.start === start ? planQ.data.entries : []), [planQ.data, start]);
  const loading = planQ.isLoading || (planQ.isFetching && planQ.data?.start !== start);
  const byCell = useMemo(() => {
    const m = new Map<string, PlanEntry[]>();
    for (const e of entries) m.set(`${e.date}|${e.slot}`, [...(m.get(`${e.date}|${e.slot}`) ?? []), e]);
    return m;
  }, [entries]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const goWeek = (s: string) => {
    const next = new URLSearchParams(params);
    if (s === thisWeek) next.delete('week');
    else next.set('week', s);
    setParams(next, { replace: false });
  };

  const openAdd = (date: string, slot: Slot) => setDialog({ date, slot });
  const openEntry = (entry: PlanEntry) => setDialog({ entry, date: entry.date, slot: entry.slot });

  // Undo brings back the exact same meal (server-side soft delete), without new activity or notifications.
  const undo = async (path: string, body?: unknown) => {
    try {
      const res = await api.post<{ skipped?: number }>(path, body);
      await qc.invalidateQueries({ queryKey: ['meals'] });
      if (res?.skipped) toast.warning('Undone — mostly', { description: `${plural(res.skipped, 'meal')} didn't fit: those slots are full now.` });
      else toast.success('Undone');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const onDeleted = (e: PlanEntry) =>
    toast.success(`Removed ${e.title}`, { action: { label: 'Undo', onClick: () => undo(`/meals/plan/${e.id}/restore`) } });

  // Drag & drop (desktop): optimistic move.
  const move = async (entryId: number, date: string, slot: Slot) => {
    const key = keys.plan(start);
    const prev = qc.getQueryData<PlanResponse>(key);
    const entry = prev?.entries.find((e) => e.id === entryId);
    if (!prev || !entry || (entry.date === date && entry.slot === slot)) return;
    await qc.cancelQueries({ queryKey: key });
    qc.setQueryData<PlanResponse>(key, { ...prev, entries: prev.entries.map((e) => (e.id === entryId ? { ...e, date, slot, position: 99 } : e)) });
    try {
      await api.patch(`/meals/plan/${entryId}`, { date, slot });
      toast.success(`Moved ${entry.title}`, { description: `${fmtDate(date, 'EEEE')} · ${slotMeta(slot).label}` });
    } catch (err) {
      qc.setQueryData(key, prev);
      toast.error(errorMessage(err));
    } finally {
      qc.invalidateQueries({ queryKey: ['meals'] });
    }
  };

  const copyFrom = async (replace: boolean) => {
    const from = shiftDays(start, -7);
    if (replace || entries.length) {
      const ok = await confirm(
        replace
          ? { title: 'Replace this week?', message: `Every meal planned for ${weekLabel(start)} is removed and replaced with the meals from the week before.`, confirmLabel: 'Replace week', danger: true }
          : { title: "Copy last week's meals?", message: 'Meals already planned this week stay. Anything that is already on the plan is skipped.', confirmLabel: 'Copy meals' },
      );
      if (!ok) return;
    }
    setBusy('copy');
    try {
      const res = await api.post<{ copied: number; skipped: number; replaced: number; batch: string }>('/meals/plan/copy', { from, to: start, replace });
      await qc.invalidateQueries({ queryKey: ['meals'] });
      const action = { label: 'Undo', onClick: () => undo('/meals/plan/restore', { batch: res.batch }) };
      if (res.copied || res.replaced) {
        toast.success(replace ? `Replaced with ${plural(res.copied, 'meal')} from last week` : `Copied ${plural(res.copied, 'meal')} from last week`, {
          description: res.skipped ? `${plural(res.skipped, 'meal')} already planned` : undefined,
          action,
          duration: 8000,
        });
      } else toast.info('Nothing new to copy', { description: 'Those meals are already on the plan.' });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const clearWeek = async () => {
    const ok = await confirm({ title: 'Clear this week?', message: `All ${plural(entries.length, 'meal')} planned for ${weekLabel(start)} will be removed.`, confirmLabel: 'Clear week', danger: true });
    if (!ok) return;
    setBusy('clear');
    try {
      const res = await api.del<{ deleted: number; batch: string }>(`/meals/plan?start=${start}&days=7`);
      await qc.invalidateQueries({ queryKey: ['meals'] });
      toast.success(`Cleared ${plural(res.deleted, 'meal')}`, { action: { label: 'Undo', onClick: () => undo('/meals/plan/restore', { batch: res.batch }) }, duration: 8000 });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const planned = entries.length;
  const dinners = new Set(entries.filter((e) => e.slot === 'dinner').map((e) => e.date)).size;
  const rel = relativeWeek(start);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-3">
        <div className="flex items-center gap-1">
          <IconButton icon={ChevronLeft} label="Previous week" variant="secondary" onClick={() => goWeek(shiftDays(start, -7))} />
          <IconButton icon={ChevronRight} label="Next week" variant="secondary" onClick={() => goWeek(shiftDays(start, 7))} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold leading-tight tracking-tight text-fg" aria-live="polite">{weekLabel(start)}</h2>
          <p className="text-[13px] text-muted">
            {rel ? `${rel} · ` : ''}
            {loading ? 'Loading…' : planned ? `${plural(planned, 'meal')} planned · dinner ${dinners}/7 nights` : 'Nothing planned yet'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {start !== thisWeek && (
            <Button variant="secondary" size="md" icon={CalendarDays} onClick={() => goWeek(thisWeek)} aria-label="Go to this week" className="max-sm:size-11 max-sm:px-0">
              <span className="max-sm:hidden">Today</span>
            </Button>
          )}
          {isGrownUp && (
            <Button variant="secondary" icon={Copy} loading={busy === 'copy'} onClick={() => copyFrom(false)} className="max-sm:hidden">
              Copy last week
            </Button>
          )}
          <Button icon={ShoppingCart} onClick={() => setShopOpen(true)} disabled={!planned} style={{ backgroundColor: ACCENT_SOLID }} className="text-white hover:brightness-105 max-sm:hidden">
            Shopping list
          </Button>
          {isGrownUp && (
            <Menu
              label="Week actions"
              trigger={() => <IconButton icon={MoreHorizontal} label="Week actions" variant="ghost" className="size-11" />}
              items={[
                { label: 'Add ingredients to shopping list', icon: ShoppingCart, onSelect: () => setShopOpen(true), disabled: !planned },
                { label: 'Copy last week', icon: Copy, onSelect: () => copyFrom(false) },
                { label: 'Replace with last week', icon: Replace, onSelect: () => copyFrom(true) },
                'divider',
                { label: 'Clear this week', icon: Eraser, danger: true, disabled: !planned, onSelect: clearWeek },
              ]}
            />
          )}
        </div>
      </div>

      {/* Mobile quick actions */}
      <div className={cn('mb-4 grid grid-cols-2 gap-2 sm:hidden', !loading && planned === 0 && 'hidden')}>
        <Button variant="secondary" icon={Copy} loading={busy === 'copy'} disabled={!isGrownUp} onClick={() => copyFrom(false)}>
          Copy last week
        </Button>
        <Button icon={ShoppingCart} onClick={() => setShopOpen(true)} disabled={!planned} style={{ backgroundColor: ACCENT_SOLID }} className="text-white">
          Shopping list
        </Button>
      </div>

      {!loading && planned === 0 && (
        <EmptyWeek
          canCopy={isGrownUp}
          copying={busy === 'copy'}
          onCopy={() => copyFrom(false)}
          onPlan={(recipeId) => setDialog({ date: days.includes(today) ? today : days[0], slot: 'dinner', recipeId })}
        />
      )}

      {isDesktop ? (
        <WeekGrid
          days={days}
          today={today}
          loading={loading}
          byCell={byCell}
          memberById={memberById}
          onAdd={openAdd}
          onOpen={openEntry}
          onMove={move}
        />
      ) : (
        <WeekList days={days} today={today} loading={loading} byCell={byCell} memberById={memberById} onAdd={openAdd} onOpen={openEntry} />
      )}

      <Fab
        label="Plan a meal"
        accent={ACCENT_SOLID}
        onClick={() => openAdd(days.includes(today) ? today : days[0], new Date().getHours() < 10 ? 'breakfast' : new Date().getHours() < 14 ? 'lunch' : 'dinner')}
      />
      <PlanEntryDialog state={dialog} onClose={() => setDialog(null)} onDeleted={onDeleted} />
      <ShoppingDialog open={shopOpen} onClose={() => setShopOpen(false)} start={start} />
    </div>
  );
}

interface ViewProps {
  days: string[];
  today: string;
  loading: boolean;
  byCell: Map<string, PlanEntry[]>;
  memberById: Map<number, Member>;
  onAdd: (date: string, slot: Slot) => void;
  onOpen: (entry: PlanEntry) => void;
}

// ------------------------------------------------------------------ desktop grid

function WeekGrid({ days, today, loading, byCell, memberById, onAdd, onOpen, onMove }: ViewProps & { onMove: (id: number, date: string, slot: Slot) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const dragging = useRef<number | null>(null);

  const dropProps = (date: string, slot: Slot) => ({
    onDragOver: (e: DragEvent) => {
      if (dragging.current == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(`${date}|${slot}`);
    },
    onDragLeave: () => setOver((o) => (o === `${date}|${slot}` ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const id = dragging.current;
      dragging.current = null;
      if (id != null) onMove(id, date, slot);
    },
  });

  return (
    <Card padding="none">
      <div role="grid" aria-label="Weekly meal plan" className="grid grid-cols-[104px_repeat(4,minmax(0,1fr))]">
        {/* Column headers stick just below the shell's 64px top bar (--meals-sticky-top). */}
        <div role="row" className="contents">
          <div role="columnheader" className="sticky top-[var(--meals-sticky-top,64px)] z-10 rounded-tl-2xl border-b border-border bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-subtle">Day</div>
          {SLOTS.map((s, si) => (
            <div key={s.id} role="columnheader" className={cn('sticky top-[var(--meals-sticky-top,64px)] z-10 flex items-center gap-2 border-b border-l border-border bg-surface-2 px-3 py-3 text-[13px] font-semibold text-fg', si === SLOTS.length - 1 && 'rounded-tr-2xl')}>
              <span className="flex size-6 items-center justify-center rounded-lg" style={{ backgroundColor: `color-mix(in oklab, ${s.color} 16%, transparent)`, color: s.color }}>
                <s.icon size={14} />
              </span>
              {s.label}
            </div>
          ))}
        </div>
        {days.map((date, di) => {
          const isToday = date === today;
          const d = toDate(date)!;
          return (
            <div role="row" key={date} className="contents">
              <div
                role="rowheader"
                className={cn('flex flex-col justify-center gap-0.5 px-4 py-3', di < 6 ? 'border-b border-border' : 'rounded-bl-2xl', isToday && 'bg-[color-mix(in_oklab,#F76B15_7%,transparent)]')}
              >
                <span className={cn('text-xs font-semibold uppercase tracking-wide', isToday ? 'text-warning-soft-fg' : 'text-subtle')}>{fmtDate(d, 'EEE')}</span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn('flex size-8 items-center justify-center rounded-full text-[15px] font-bold tabular-nums', isToday ? 'text-white' : 'text-fg')}
                    style={isToday ? { backgroundColor: '#C2410C' } : undefined}
                  >
                    {fmtDate(d, 'd')}
                  </span>
                  {isToday && <span className="text-[11px] font-semibold text-warning-soft-fg">Today</span>}
                </span>
              </div>
              {SLOTS.map((s, si) => {
                const cell = byCell.get(`${date}|${s.id}`) ?? [];
                const key = `${date}|${s.id}`;
                return (
                  <div
                    role="gridcell"
                    key={s.id}
                    {...dropProps(date, s.id)}
                    className={cn(
                      'group/cell relative flex min-h-[84px] flex-col gap-1.5 border-l border-border p-2 transition-colors',
                      di < 6 && 'border-b',
                      di === 6 && si === SLOTS.length - 1 && 'rounded-br-2xl',
                      isToday && 'bg-[color-mix(in_oklab,#F76B15_5%,transparent)]',
                      over === key && 'bg-primary-soft ring-2 ring-inset ring-primary/50',
                    )}
                  >
                    {loading ? (
                      di % 2 === s.id.length % 2 ? <Skeleton className="h-12 w-full rounded-xl" /> : null
                    ) : (
                      cell.map((e) => (
                        <GridChip
                          key={e.id}
                          entry={e}
                          cook={e.cook_id ? memberById.get(e.cook_id) : undefined}
                          onOpen={() => onOpen(e)}
                          onDragStart={() => (dragging.current = e.id)}
                          onDragEnd={() => { dragging.current = null; setOver(null); }}
                        />
                      ))
                    )}
                    {!loading && (
                      <button
                        type="button"
                        onClick={() => onAdd(date, s.id)}
                        aria-label={`Add ${s.label.toLowerCase()} on ${fmtDate(d, 'EEEE, MMM d')}`}
                        className={cn(
                          'flex items-center justify-center gap-1 rounded-xl text-xs font-semibold text-subtle transition focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          cell.length
                            ? 'h-7 opacity-0 hover:bg-surface-2 hover:text-fg group-hover/cell:opacity-100'
                            : 'h-full min-h-[64px] flex-1 border border-dashed border-transparent hover:border-border-strong hover:bg-surface-2/60 hover:text-fg group-hover/cell:border-border',
                        )}
                      >
                        <Plus size={14} />
                        <span className={cn(!cell.length && 'opacity-0 group-hover/cell:opacity-100')}>Add</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function GridChip({ entry, cook, onOpen, onDragStart, onDragEnd }: {
  entry: PlanEntry; cook?: Member; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(entry.id));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      title={entry.note ?? entry.title}
      className="group flex w-full cursor-grab items-center gap-2 rounded-xl border border-border bg-surface p-1.5 pr-2 text-left shadow-xs transition hover:-translate-y-px hover:border-border-strong hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing animate-fade-in"
    >
      {entry.recipe ? (
        <RecipeArt recipe={entry.recipe} className="size-10 shrink-0" rounded="rounded-lg" iconSize={18} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-subtle" aria-hidden>
          <ChefHat size={17} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] font-semibold leading-tight text-fg">{entry.title}</span>
        {(entry.recipe?.total_minutes || entry.note) && (
          <span className="mt-0.5 block truncate text-[11px] text-muted">
            {entry.note ?? fmtMinutes(entry.recipe?.total_minutes)}
          </span>
        )}
      </span>
      {cook && <Avatar user={cook} size="xs" className="shrink-0" />}
    </button>
  );
}

// ------------------------------------------------------------------ mobile list

function WeekList({ days, today, loading, byCell, memberById, onAdd, onOpen }: ViewProps) {
  const [selected, setSelected] = useState(days.includes(today) ? today : days[0]);
  const scrolledFor = useRef<string | null>(null);
  const clickLock = useRef(0);
  const jump = (date: string, smooth = true) => {
    setSelected(date);
    clickLock.current = Date.now();
    document.getElementById(`meals-day-${date}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
  };

  // Open on today (not Monday) once the week has rendered.
  useEffect(() => {
    if (loading || scrolledFor.current === days[0]) return;
    scrolledFor.current = days[0];
    const target = days.includes(today) ? today : days[0];
    setSelected(target);
    if (target !== days[0]) requestAnimationFrame(() => jump(target, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, days[0], today]);

  // Keep the strip in sync with the day you're looking at while scrolling.
  useEffect(() => {
    const cards = days.map((d) => document.getElementById(`meals-day-${d}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (list) => {
        if (Date.now() - clickLock.current < 800) return; // a tap just chose the day
        const top = list.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setSelected(top.target.id.replace('meals-day-', ''));
      },
      { rootMargin: '-190px 0px -55% 0px' },
    );
    cards.forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, [days]);

  return (
    <div>
      <div
        className="sticky top-[calc(56px+env(safe-area-inset-top))] z-20 -mx-4 mb-4 flex gap-1.5 overflow-x-auto bg-bg/90 px-4 py-2 backdrop-blur-md scrollbar-none sm:mx-0 sm:px-0"
        role="tablist"
        aria-label="Jump to day"
      >
        {days.map((date) => {
          const d = toDate(date)!;
          const count = SLOTS.reduce((n, s) => n + (byCell.get(`${date}|${s.id}`)?.length ?? 0), 0);
          const isToday = date === today;
          const isSel = date === selected;
          return (
            <button
              key={date}
              type="button"
              role="tab"
              aria-selected={isSel}
              onClick={() => jump(date)}
              aria-label={`${fmtDate(d, 'EEEE')}${isToday ? ' (today)' : ''}, ${plural(count, 'meal')}`}
              className={cn(
                'relative flex min-h-[60px] min-w-[46px] flex-1 flex-col items-center gap-0.5 rounded-2xl border px-1 py-2 transition',
                isSel ? 'border-transparent text-white shadow-card' : 'bg-surface text-fg',
                !isSel && (isToday ? 'border-2 border-[#C2410C]' : 'border-border'),
              )}
              style={isSel ? { backgroundColor: '#C2410C' } : undefined}
            >
              <span className={cn('text-[11px] font-semibold uppercase', isSel ? 'text-white/85' : isToday ? 'text-[#C2410C] dark:text-[#ffa057]' : 'text-subtle')}>
                {isToday ? 'Today' : fmtDate(d, 'EEEEE')}
              </span>
              <span className="text-base font-bold tabular-nums">{fmtDate(d, 'd')}</span>
              <span className="flex h-1.5 gap-0.5" aria-hidden>
                {Array.from({ length: Math.min(count, 4) }, (_, i) => (
                  <span key={i} className={cn('size-1.5 rounded-full', isSel ? 'bg-white/90' : 'bg-[#F76B15]')} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
        {days.map((date) => {
          const d = toDate(date)!;
          const isToday = date === today;
          return (
            <Card key={date} id={`meals-day-${date}`} padding="none" className={cn('scroll-mt-[150px] overflow-hidden', isToday && 'ring-2 ring-[#F76B15]/50')}>
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <h3 className="text-[15px] font-bold text-fg">
                  {fmtDate(d, 'EEEE')} <span className="font-medium text-muted">{fmtDate(d, 'MMM d')}</span>
                </h3>
                {isToday && <span className="rounded-full px-2 py-0.5 text-[11px] font-bold text-white" style={{ backgroundColor: '#C2410C' }}>Today</span>}
              </div>
              <ul className="divide-y divide-border">
                {SLOTS.map((s) => {
                  const cell = byCell.get(`${date}|${s.id}`) ?? [];
                  return (
                    <li key={s.id} className="flex items-start gap-3 px-3 py-2.5">
                      <span className="mt-1 flex w-[76px] shrink-0 items-center gap-1.5 text-[12px] font-semibold text-muted">
                        <span className="flex size-6 items-center justify-center rounded-lg" style={{ backgroundColor: `color-mix(in oklab, ${s.color} 16%, transparent)`, color: s.color }}>
                          <s.icon size={13} />
                        </span>
                        {s.label}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        {loading ? (
                          <Skeleton className="h-9 w-3/4 rounded-xl" />
                        ) : (
                          <>
                            {cell.map((e) => {
                              const cook = e.cook_id ? memberById.get(e.cook_id) : undefined;
                              return (
                                <button
                                  key={e.id}
                                  type="button"
                                  onClick={() => onOpen(e)}
                                  className="flex w-full items-center gap-2.5 rounded-xl p-1 text-left transition hover:bg-surface-2 active:scale-[0.99]"
                                >
                                  {e.recipe ? (
                                    <RecipeArt recipe={e.recipe} className="size-11 shrink-0" rounded="rounded-xl" iconSize={20} />
                                  ) : (
                                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-subtle" aria-hidden><ChefHat size={18} /></span>
                                  )}
                                  <span className="min-w-0 flex-1">
                                    <span className="line-clamp-2 text-[14px] font-semibold leading-snug text-fg">{e.title}</span>
                                    <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                                      {cook && <><Avatar user={cook} size="xs" /> {firstName(cook.name)}</>}
                                      {cook && (e.recipe?.total_minutes || e.note) ? <span aria-hidden>·</span> : null}
                                      {e.note ? <span className="truncate">{e.note}</span> : e.recipe?.total_minutes ? <span className="inline-flex items-center gap-1"><Clock size={11} />{fmtMinutes(e.recipe.total_minutes)}</span> : null}
                                    </span>
                                  </span>
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() => onAdd(date, s.id)}
                              aria-label={`Add ${s.label.toLowerCase()} on ${fmtDate(d, 'EEEE')}`}
                              className={cn(
                                'inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg px-2 text-[13px] font-medium text-subtle transition hover:bg-surface-2 hover:text-fg',
                              )}
                            >
                              <Plus size={14} /> {cell.length ? 'Add dish' : `Add ${s.label.toLowerCase()}`}
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ empty week

function EmptyWeek({ canCopy, copying, onCopy, onPlan }: { canCopy: boolean; copying: boolean; onCopy: () => void; onPlan: (recipeId?: number) => void }) {
  const recipesQ = useRecipes({ sort: 'popular' });
  const ideas = (recipesQ.data ?? []).slice().sort((a, b) => Number(b.favorite) - Number(a.favorite)).slice(0, 4);
  return (
    <Card className="mb-4 overflow-hidden animate-fade-in" padding="none">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6" style={{ background: 'linear-gradient(120deg, color-mix(in oklab, #F76B15 12%, transparent), transparent 70%)' }}>
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-card" style={{ backgroundColor: ACCENT_SOLID }} aria-hidden>
          <Sparkles size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-bold tracking-tight text-fg">A fresh week to plan</h3>
          <p className="mt-0.5 text-sm text-muted">Start from last week's menu, or pick a family favorite for tonight.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCopy && <Button variant="secondary" icon={Copy} loading={copying} onClick={onCopy}>Copy last week</Button>}
          <Button icon={CalendarPlus} onClick={() => onPlan()} style={{ backgroundColor: ACCENT_SOLID }} className="text-white hover:brightness-105">Plan a meal</Button>
        </div>
      </div>
      {ideas.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t border-border px-5 py-3 scrollbar-none sm:px-6" aria-label="Suggested recipes">
          <span className="shrink-0 self-center text-xs font-semibold uppercase tracking-wide text-subtle">Ideas</span>
          {ideas.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onPlan(r.id)}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3.5 text-[13px] font-semibold text-fg transition hover:border-border-strong hover:shadow-card"
            >
              <RecipeArt recipe={r} className="size-9 shrink-0" rounded="rounded-full" iconSize={16} />
              {r.title}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
