import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { format } from 'date-fns';
import { CalendarPlus, Camera, ListPlus, PenLine, type LucideIcon } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { firstName, plural } from '../../lib/format';
import { AvatarStack, Skeleton } from '../../ui';
import { upcomingBirthdays } from './Glance';
import type { Dashboard } from './types';

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export interface QuickActions {
  post: () => void;
  event: () => void;
  item: () => void;
  photo: () => void;
}

export function Hero({ dashboard, loading, actions }: { dashboard: Dashboard | undefined; loading: boolean; actions: QuickActions }) {
  const { user, family, members } = useAuth();
  const now = new Date();
  const birthdaysToday = upcomingBirthdays(members).filter((b) => b.days === 0);

  const chips: ReactNode[] = [];
  const cal = dashboard?.calendar;
  const lists = dashboard?.lists;
  const meals = dashboard?.meals;
  if (cal) chips.push(cal.today?.length ? plural(cal.today.length, 'event') + ' today' : 'No events today');
  if (lists) {
    const due = (lists.due?.length ?? 0) + (lists.overdue?.length ?? 0);
    chips.push(due ? `${plural(due, 'task')} due${lists.overdue?.length ? ` (${lists.overdue.length} overdue)` : ''}` : 'No tasks due');
  }
  const dinner = meals?.today?.find((m) => m.slot === 'dinner');
  if (dinner) chips.push(`${dinner.title} for dinner`);

  return (
    <section
      aria-label="Welcome"
      className="relative isolate overflow-hidden rounded-3xl px-4 pb-4 pt-5 text-white shadow-lift sm:px-7 sm:pb-6 sm:pt-7"
      style={{ background: 'linear-gradient(125deg, #3f3fb5 0%, #5B5BD6 38%, #7a4cc2 70%, #a8398a 100%)' }}
    >
      <style>{'@keyframes wall-wave{0%,60%,100%{transform:rotate(0)}10%,30%{transform:rotate(14deg)}20%{transform:rotate(-8deg)}40%{transform:rotate(-4deg)}50%{transform:rotate(10deg)}}'}</style>
      {/* soft decorative light */}
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 -z-10 size-72 rounded-full bg-white/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-28 left-1/4 -z-10 size-72 rounded-full bg-[#ffb224]/25 blur-3xl" />
      <svg aria-hidden className="pointer-events-none absolute right-4 top-4 -z-10 hidden opacity-20 sm:block" width="180" height="120" viewBox="0 0 180 120" fill="none">
        <path d="M20 100 L90 40 L160 100" stroke="white" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M45 100 V80 M135 100 V80" stroke="white" strokeWidth="8" strokeLinecap="round" />
        <path d="M90 78 c-8 -10 -22 -2 -14 10 l14 12 l14 -12 c8 -12 -6 -20 -14 -10 z" fill="white" />
      </svg>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-white/80">{format(now, 'EEEE, MMMM d')}</p>
          <h1 className="mt-1 text-[25px] font-bold leading-tight tracking-tight sm:text-[34px]">
            {greeting(now)}, {firstName(user?.name) || 'there'} <span aria-hidden className="inline-block origin-[70%_70%] motion-safe:animate-[wall-wave_2.2s_ease-in-out_1]">👋</span>
          </h1>
          {birthdaysToday.length > 0 ? (
            <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-sm font-semibold backdrop-blur">
              🎂 It's {birthdaysToday.map((b) => (b.member.id === user?.id ? 'your' : `${firstName(b.member.name)}'s`)).join(' & ')} birthday today!
            </p>
          ) : null}
          <div className="mt-1.5 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-white/90 sm:mt-2 sm:text-[15px]">
            {loading ? (
              <Skeleton className="h-4 w-56 bg-white/20!" />
            ) : chips.length ? (
              chips.map((c, i) => (
                <span key={i} className="inline-flex items-center gap-2">
                  {i > 0 && <span aria-hidden className="size-1 rounded-full bg-white/60" />}
                  {c}
                </span>
              ))
            ) : (
              <span>Here's what's happening in {family?.name ?? 'your family'}.</span>
            )}
          </div>
        </div>
        {members.length > 1 && (
          <Link to="/family" className="hidden shrink-0 items-center gap-2 rounded-full bg-white/15 py-1 pl-1 pr-3 text-sm font-semibold backdrop-blur transition hover:bg-white/25 sm:flex" aria-label={`${family?.name}: ${members.length} members`}>
            <AvatarStack users={members} max={5} size="sm" />
            <span>{members.length}</span>
          </Link>
        )}
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2 sm:mt-6 sm:gap-3">
        <QuickAction icon={PenLine} label="New post" onClick={actions.post} />
        <QuickAction icon={CalendarPlus} label="Event" onClick={actions.event} />
        <QuickAction icon={ListPlus} label="List item" onClick={actions.item} />
        <QuickAction icon={Camera} label="Photo" onClick={actions.photo} />
      </div>
    </section>
  );
}

function QuickAction({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-w-0 flex-col items-center gap-1.5 rounded-2xl bg-white/15 px-1 py-2.5 text-[12.5px] font-semibold text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-white/25 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 sm:flex-row sm:justify-center sm:gap-2 sm:py-3.5 sm:text-sm"
    >
      <Icon size={20} className="shrink-0 transition-transform group-hover:scale-110" />
      <span className="truncate">{label}</span>
    </button>
  );
}
