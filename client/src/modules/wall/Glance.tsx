import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { differenceInCalendarDays, format } from 'date-fns';
import { ArrowRight, Cake, CalendarDays, ChevronRight, ListChecks, MapPin, PartyPopper, UtensilsCrossed, type LucideIcon } from 'lucide-react';
import { moduleMeta } from '../../layout/moduleMeta';
import { cn } from '../../lib/cn';
import { firstName, fmtDay, fmtTime, toDate, toDateKey } from '../../lib/format';
import type { Member } from '../../lib/types';
import { Avatar, Card, Skeleton } from '../../ui';
import type { DashEvent, DashItem, DashMeal, Dashboard } from './types';

// ---------- helpers ----------

export interface UpcomingBirthday {
  member: Member;
  date: Date;
  days: number;
  turns: number | null;
}

/** Next birthday of every member with one set, soonest first. */
export function upcomingBirthdays(members: Member[], now = new Date()): UpcomingBirthday[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return members
    .filter((m) => m.birthday && toDate(m.birthday))
    .map((m) => {
      const b = toDate(m.birthday)!;
      let next = new Date(today.getFullYear(), b.getMonth(), b.getDate());
      if (b.getMonth() === 1 && b.getDate() === 29 && next.getMonth() !== 1) next = new Date(today.getFullYear(), 1, 28);
      if (next < today) next = new Date(today.getFullYear() + 1, b.getMonth(), b.getDate());
      const turns = b.getFullYear() > 1900 ? next.getFullYear() - b.getFullYear() : null;
      return { member: m, date: next, days: differenceInCalendarDays(next, today), turns };
    })
    .sort((a, b) => a.days - b.days);
}

const shortDay = (v: string) => {
  const label = fmtDay(v);
  return label === 'Today' || label === 'Tomorrow' ? label : format(toDate(v) ?? new Date(), 'EEE d');
};

const isAllDay = (e: DashEvent) => !!e.all_day || /^\d{4}-\d{2}-\d{2}$/.test(e.start);

// ---------- shell ----------

function GlanceCard({
  moduleId, icon, title, subtitle, to, children, className, accent: accentOverride,
}: {
  moduleId: string; icon?: LucideIcon; title: string; subtitle?: ReactNode; to?: string; children: ReactNode; className?: string; accent?: string;
}) {
  const meta = moduleMeta(moduleId);
  const Icon = icon ?? meta.icon;
  const accent = accentOverride ?? meta.accent;
  return (
    <Card padding="none" className={cn('flex flex-col overflow-hidden', className)}>
      <section aria-label={title} className="flex flex-1 flex-col">
        <header className="flex items-center gap-3 px-4 pb-2 pt-4">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: `color-mix(in oklab, ${accent} 15%, transparent)`, color: accent }}
            aria-hidden
          >
            <Icon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-fg">{title}</h3>
            {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
          </div>
          {to && (
            <Link to={to} className="-mr-1 inline-flex size-8 items-center justify-center rounded-lg text-subtle transition hover:bg-surface-2 hover:text-fg" aria-label={`Open ${meta.label}`}>
              <ChevronRight size={18} />
            </Link>
          )}
        </header>
        <div className="flex flex-1 flex-col px-4 pb-4">{children}</div>
      </section>
    </Card>
  );
}

/** Friendly state for a module that isn't set up / has nothing to show. */
function Fallback({ icon: Icon, accent, title, text, to, cta, compact }: { icon: LucideIcon; accent: string; title: string; text: string; to: string; cta: string; compact?: boolean }) {
  return (
    <div
      className={cn('flex flex-1 flex-col items-start justify-center rounded-xl', compact ? 'gap-1 p-3' : 'gap-2 p-3.5')}
      style={{ background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 9%, transparent), color-mix(in oklab, ${accent} 3%, transparent))` }}
    >
      <Icon size={20} style={{ color: accent }} aria-hidden />
      <div>
        <p className="text-sm font-semibold text-fg">{title}</p>
        {!compact && <p className="mt-0.5 text-[13px] leading-snug text-muted">{text}</p>}
      </div>
      <Link to={to} className="mt-1 inline-flex items-center gap-1 text-[13px] font-semibold hover:underline" style={{ color: `color-mix(in oklab, ${accent} 75%, var(--fg))` }}>
        {cta} <ArrowRight size={14} />
      </Link>
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-3 pt-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-1 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-3.5" style={{ width: `${75 - i * 15}%` }} />
            <Skeleton className="mt-1.5 h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Today (calendar) ----------

function EventRow({ e, showDay }: { e: DashEvent; showDay?: boolean }) {
  const color = e.color || moduleMeta('calendar').accent;
  const allDay = isAllDay(e);
  return (
    <li>
      <Link to="/calendar" className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-1.5 transition hover:bg-surface-2">
        <span className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums text-muted">
          {showDay ? shortDay(e.start) : allDay ? 'All day' : fmtTime(e.start)}
        </span>
        <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{e.title}</span>
          {(e.location || (showDay && !allDay)) && (
            <span className="flex items-center gap-1 truncate text-xs text-subtle">
              {showDay && !allDay && <span>{fmtTime(e.start)}</span>}
              {e.location && (
                <>
                  <MapPin size={11} className="shrink-0" /> <span className="truncate">{e.location}</span>
                </>
              )}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

export function TodayCard({ data, loading, className, compact }: { data: Dashboard['calendar']; loading: boolean; className?: string; compact?: boolean }) {
  const accent = moduleMeta('calendar').accent;
  const today = data?.today ?? [];
  const todayIds = new Set(today.map((e) => String(e.id) + e.start));
  const todayKey = toDateKey(new Date());
  const upcoming = (data?.upcoming ?? []).filter((e) => !todayIds.has(String(e.id) + e.start) && toDateKey(e.start) > todayKey)
    .slice(0, compact ? 2 : 3);
  const sorted = [...today].sort((a, b) => Number(!isAllDay(a)) - Number(!isAllDay(b)) || a.start.localeCompare(b.start));
  return (
    <GlanceCard moduleId="calendar" title="Today" subtitle={format(new Date(), 'EEEE, MMMM d')} to={data ? '/calendar' : undefined} className={className}>
      {loading ? (
        <RowsSkeleton />
      ) : !data ? (
        <Fallback icon={CalendarDays} accent={accent} title="Plan your week together" text="School runs, practices and date nights — all in one shared calendar." to="/calendar" cta="Open calendar" compact={compact} />
      ) : (
        <>
          {sorted.length ? (
            <ul className="flex flex-col">{sorted.slice(0, compact ? 3 : 5).map((e) => <EventRow key={`${e.id}-${e.start}`} e={e} />)}</ul>
          ) : (
            <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
              <PartyPopper size={16} className="shrink-0" style={{ color: accent }} /> Nothing scheduled today
            </p>
          )}
          {sorted.length > (compact ? 3 : 5) && <p className="mt-1 text-xs text-subtle">+{sorted.length - (compact ? 3 : 5)} more today</p>}
          {upcoming.length > 0 && (!compact || !sorted.length) && (
            <>
              <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-subtle">Coming up</p>
              <ul className="flex flex-col">{upcoming.map((e) => <EventRow key={`${e.id}-${e.start}`} e={e} showDay />)}</ul>
            </>
          )}
        </>
      )}
    </GlanceCard>
  );
}

// ---------- Tasks (lists) ----------

function TaskRow({ item, overdue, members }: { item: DashItem; overdue?: boolean; members: Member[] }) {
  const who = item.assignee_id ? members.find((m) => m.id === item.assignee_id) : null;
  return (
    <li>
      <Link to={`/lists/${item.list_id}`} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-1.5 transition hover:bg-surface-2">
        <span className={cn('size-4 shrink-0 rounded-full border-2', overdue ? 'border-danger' : 'border-border-strong')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{item.text}</span>
          <span className="flex items-center gap-1.5 truncate text-xs text-subtle">
            {overdue ? (
              <span className="font-semibold text-danger">Overdue{item.due_date ? ` · ${fmtDay(item.due_date)}` : ''}</span>
            ) : (
              <span>{item.due_date ? fmtDay(item.due_date) : 'Today'}</span>
            )}
            {item.list_name && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{item.list_name}</span>
              </>
            )}
          </span>
        </span>
        {who && <Avatar user={who} size="xs" title={`Assigned to ${who.name}`} />}
      </Link>
    </li>
  );
}

export function TasksCard({ data, loading, members, className, compact }: { data: Dashboard['lists']; loading: boolean; members: Member[]; className?: string; compact?: boolean }) {
  const max = compact ? 3 : 5;
  const accent = moduleMeta('lists').accent;
  const overdue = data?.overdue ?? [];
  const due = data?.due ?? [];
  const total = overdue.length + due.length;
  const lists = (data?.lists ?? []).filter((l) => l.open_count > 0).slice(0, 4);
  return (
    <GlanceCard
      moduleId="lists"
      title="Tasks due"
      subtitle={data ? (total ? `${total} to do${overdue.length ? ` · ${overdue.length} overdue` : ''}` : 'All clear') : undefined}
      to={data ? '/lists' : undefined}
      className={className}
    >
      {loading ? (
        <RowsSkeleton />
      ) : !data ? (
        <Fallback icon={ListChecks} accent={accent} title="Share the to-dos" text="Groceries, chores and packing lists that everyone can check off." to="/lists" cta="Open lists" compact={compact} />
      ) : (
        <>
          {total ? (
            <ul className="flex flex-col">
              {overdue.slice(0, Math.min(3, max)).map((i) => <TaskRow key={`o${i.id}`} item={i} overdue members={members} />)}
              {due.slice(0, Math.max(0, max - Math.min(overdue.length, 3, max))).map((i) => <TaskRow key={`d${i.id}`} item={i} members={members} />)}
            </ul>
          ) : (
            <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
              <ListChecks size={16} className="shrink-0" style={{ color: accent }} /> Nothing due today — nice work!
            </p>
          )}
          {total > max && <p className="mt-1 text-xs text-subtle">+{total - max} more</p>}
          {lists.length > 0 && !compact && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {lists.map((l) => (
                <Link
                  key={l.id}
                  to={`/lists/${l.id}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg transition hover:border-border-strong hover:bg-surface-2"
                >
                  {l.name} <span className="rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold tabular-nums text-muted">{l.open_count}</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </GlanceCard>
  );
}

// ---------- Meals ----------

const SLOT_ORDER = ['breakfast', 'lunch', 'snack', 'dinner'];
const SLOT_EMOJI: Record<string, string> = { breakfast: '🥞', lunch: '🥪', snack: '🍎', dinner: '🍽️' };

export function MealsCard({ data, loading, className, compact }: { data: Dashboard['meals']; loading: boolean; className?: string; compact?: boolean }) {
  const accent = moduleMeta('meals').accent;
  const meals = [...(data?.today ?? [])].sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  const dinner = meals.find((m) => m.slot === 'dinner');
  const rest = meals.filter((m) => m !== dinner).slice(0, compact && dinner ? 2 : 4);
  return (
    <GlanceCard moduleId="meals" icon={UtensilsCrossed} title="On the menu" subtitle={data ? (meals.length ? 'Today' : 'Nothing planned today') : undefined} to={data ? '/meals' : undefined} className={className}>
      {loading ? (
        <RowsSkeleton />
      ) : !data || !meals.length ? (
        <Fallback
          icon={UtensilsCrossed}
          accent={accent}
          title={data ? "What's for dinner?" : 'Plan the week of meals'}
          text={data ? 'Pick a recipe for tonight and add the ingredients to your list.' : 'Recipes, a weekly plan and a shopping list that fills itself.'}
          to="/meals"
          cta={data ? 'Plan dinner' : 'Open meals'}
        compact={compact} />
      ) : (
        <>
          {dinner && <MealHero meal={dinner} accent={accent} />}
          {rest.length > 0 && (
            <ul className={cn('flex flex-col', dinner && 'mt-2')}>
              {rest.map((m, i) => (
                <li key={`${m.slot}-${i}`} className="flex items-center gap-3 py-1.5">
                  <span className="text-lg leading-none" aria-hidden>{SLOT_EMOJI[m.slot] ?? '🍴'}</span>
                  <span className="w-16 shrink-0 text-xs font-semibold capitalize text-muted">{m.slot}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{m.title}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </GlanceCard>
  );
}

function MealHero({ meal, accent }: { meal: DashMeal; accent: string }) {
  return (
    <Link
      to="/meals"
      className="flex items-center gap-3 rounded-xl p-3 transition hover:brightness-[0.98]"
      style={{ background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 16%, transparent), color-mix(in oklab, ${accent} 5%, transparent))` }}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface text-2xl shadow-card" aria-hidden>🍽️</span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: `color-mix(in oklab, ${accent} 70%, var(--fg))` }}>Tonight's dinner</span>
        <span className="block truncate text-[15px] font-semibold text-fg">{meal.title}</span>
      </span>
    </Link>
  );
}

// ---------- Birthdays ----------

export function BirthdaysCard({ members, className, compact }: { members: Member[]; className?: string; compact?: boolean }) {
  const list = upcomingBirthdays(members).slice(0, compact ? 2 : 4);
  const accent = '#D6409F';
  return (
    <GlanceCard moduleId="family" icon={Cake} accent={accent} title="Birthdays" subtitle={list.length ? `Next: ${firstName(list[0].member.name)} ${when(list[0].days)}` : undefined} className={className}>
      {!list.length ? (
        <Fallback icon={Cake} accent={accent} title="Never miss a birthday" text="Add birthdays to everyone's profile and we'll count down together." to="/family" cta="Open family" compact={compact} />
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((b) => (
            <li key={b.member.id} className={cn('-mx-2 flex items-center gap-3 rounded-xl px-2 py-1.5', b.days === 0 && 'bg-[color-mix(in_oklab,#D6409F_10%,transparent)]')}>
              <Avatar user={b.member} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">
                  {firstName(b.member.name)}
                  {b.days === 0 && ' 🎂'}
                </span>
                <span className="block truncate text-xs text-subtle">
                  {format(b.date, 'MMM d')}
                  {b.turns !== null && ` · turns ${b.turns}`}
                </span>
              </span>
              <span
                className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums', b.days > 7 && 'bg-surface-2 text-muted')}
                style={b.days <= 7 ? { backgroundColor: `color-mix(in oklab, ${accent} 14%, transparent)`, color: `color-mix(in oklab, ${accent} 72%, var(--fg))` } : undefined}
              >
                {b.days === 0 ? 'Today!' : b.days === 1 ? 'Tomorrow' : `${b.days} days`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </GlanceCard>
  );
}

const when = (days: number) => (days === 0 ? 'today 🎉' : days === 1 ? 'tomorrow' : `in ${days} days`);
