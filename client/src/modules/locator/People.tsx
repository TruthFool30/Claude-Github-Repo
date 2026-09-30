import { Link } from 'react-router';
import { ChevronRight, EyeOff, LogIn, LogOut, MapPinCheck, MapPinOff, Pause, Radio } from 'lucide-react';
import { cn } from '../../lib/cn';
import { firstName, fmtTime } from '../../lib/format';
import { Avatar, Badge, Button, Switch } from '../../ui';
import { ago, fmtDistance, isLiveNow, isStale } from './geo';
import { PlaceTile, placeIcon } from './placeIcons';
import type { LiveShareState } from './liveShare';
import type { LocEvent, LocMember } from './types';

/** One-line description of where a member is. */
export function whereText(m: LocMember, meId: number | null, now: number): { title: string; detail: string | null; tone: 'place' | 'away' | 'paused' | 'none' } {
  if (!m.sharing && m.id !== meId) return { title: 'Location paused', detail: m.sharing_changed_at ? `since ${ago(m.sharing_changed_at, now)}` : null, tone: 'paused' };
  const loc = m.location;
  if (!loc) return { title: m.id === meId ? 'You haven’t checked in yet' : 'No location shared yet', detail: null, tone: 'none' };
  const updated = isStale(loc, now) ? `Last seen ${ago(loc.updated_at, now)}` : `Updated ${ago(loc.updated_at, now)}`;
  if (loc.place) return { title: `At ${loc.place.name}`, detail: `${loc.since ? `since ${fmtTime(loc.since)} · ` : ''}${updated}`, tone: 'place' };
  if (loc.nearest && loc.nearest.meters < 5000) return { title: `${fmtDistance(loc.nearest.meters)} from ${loc.nearest.name}`, detail: updated, tone: 'away' };
  return { title: 'Away from saved places', detail: updated, tone: 'away' };
}

export function MemberRow({ m, meId, now, selected }: { m: LocMember; meId: number | null; now: number; selected?: boolean }) {
  const w = whereText(m, meId, now);
  const live = m.sharing && isLiveNow(m.location, now);
  const Icon = m.location?.place ? placeIcon(m.location.place.icon) : null;
  return (
    <Link
      to={`/locator/member/${m.id}`}
      className={cn(
        'group flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
        selected && 'bg-surface-2',
      )}
      data-testid={`member-${m.id}`}
      aria-label={`${m.name}: ${w.title}${w.detail ? `, ${w.detail}` : ''}`}
    >
      <span className={cn('relative', w.tone === 'paused' && 'opacity-60 grayscale')}>
        <Avatar user={m} size="lg" status={live ? 'online' : null} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-fg">{m.id === meId ? `${firstName(m.name)} (you)` : m.name}</span>
          {live && <Badge tone="success" size="sm"><Radio size={10} /> Live</Badge>}
          {m.id === meId && !m.sharing && <Badge tone="warning" size="sm"><EyeOff size={10} /> Hidden from family</Badge>}
        </div>
        <p className={cn('flex items-center gap-1.5 truncate text-[13px] font-medium', w.tone === 'place' ? 'text-fg' : 'text-muted')}>
          {Icon && m.location?.place && <Icon size={13} style={{ color: m.location.place.color }} className="shrink-0" aria-hidden />}
          {w.tone === 'paused' && <EyeOff size={13} className="shrink-0" aria-hidden />}
          <span className="truncate">{w.title}</span>
        </p>
        {w.detail && <p className="truncate text-xs text-subtle">{w.detail}</p>}
      </div>
      <ChevronRight size={18} className="shrink-0 text-subtle transition group-hover:translate-x-0.5 group-hover:text-fg" aria-hidden />
    </Link>
  );
}

export function SharingCard({
  me, sharing, onToggleSharing, live, onToggleLive, onCheckIn, now, busy,
}: {
  me: LocMember | undefined;
  sharing: boolean;
  onToggleSharing: (v: boolean) => void;
  live: LiveShareState;
  onToggleLive: (v: boolean) => void;
  onCheckIn: () => void;
  now: number;
  busy?: boolean;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-border p-4"
      style={{ background: sharing ? 'linear-gradient(135deg, color-mix(in oklab, #E5484D 9%, var(--surface)), var(--surface) 70%)' : undefined }}
      data-testid="sharing-card"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-fg">Share my location</p>
          <p className="mt-0.5 text-[13px] text-muted">
            {sharing
              ? me?.location
                ? `Family sees your last check-in · ${ago(me.location.updated_at, now)}`
                : 'On — check in so your family can see you'
              : 'Paused — nobody can see where you are'}
          </p>
          {sharing && <p className="mt-1 text-xs text-subtle">Pausing hides you and clears your past check-ins from the family feed.</p>}
        </div>
        <Switch checked={sharing} onChange={onToggleSharing} aria-label="Share my location" disabled={busy} />
      </div>
      {sharing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={MapPinCheck} onClick={onCheckIn}>Check in</Button>
          <Button
            size="sm"
            variant={live.active ? 'soft' : 'secondary'}
            icon={Radio}
            onClick={() => onToggleLive(!live.active)}
            aria-pressed={live.active}
          >
            {live.active ? 'Live sharing on' : 'Share live'}
          </Button>
          {live.active && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
              {live.lastSentAt ? `sent ${ago(new Date(live.lastSentAt).toISOString(), now)}` : 'finding you…'} · while the app is open
            </span>
          )}
        </div>
      ) : (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning-soft-fg">
          <Pause size={12} /> Sharing paused
        </p>
      )}
      {live.error && <p className="mt-2 text-xs font-medium text-danger">{live.error}</p>}
    </div>
  );
}

export function EventRow({ e, now, showUser = true }: { e: LocEvent; now: number; showUser?: boolean }) {
  const arrived = e.kind === 'arrived';
  return (
    <li className="flex items-center gap-3 py-2">
      {showUser && e.user && <Avatar user={e.user} size="sm" />}
      <span
        className={cn('flex size-6 shrink-0 items-center justify-center rounded-full', arrived ? 'bg-success-soft text-success-soft-fg' : 'bg-surface-2 text-muted')}
        aria-label={arrived ? 'Arrived' : 'Left'}
      >
        {arrived ? <LogIn size={12} /> : <LogOut size={12} />}
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] text-muted">
        {showUser && e.user && <span className="font-semibold text-fg">{firstName(e.user.name)} </span>}
        {arrived ? 'arrived at ' : 'left '}
        <span className="font-semibold text-fg">{e.place_name}</span>
      </p>
      <time className="shrink-0 text-xs tabular text-subtle" dateTime={e.created_at} title={new Date(e.created_at).toLocaleString()}>
        {ago(e.created_at, now)}
      </time>
    </li>
  );
}

/** "Where is everyone" board: members grouped by place (used as the list view / offline fallback). */
export function Board({ members, meId, now }: { members: LocMember[]; meId: number | null; now: number }) {
  const groups = new Map<string, { title: string; icon: string; color: string; people: LocMember[] }>();
  for (const m of members) {
    const w = whereText(m, meId, now);
    let key = 'away';
    let g = { title: 'Out and about', icon: 'pin', color: '#8E4EC6' };
    if (w.tone === 'paused') { key = 'paused'; g = { title: 'Paused sharing', icon: 'pin', color: '#8d90a0' }; }
    else if (w.tone === 'none') { key = 'none'; g = { title: 'No location yet', icon: 'pin', color: '#8d90a0' }; }
    else if (m.location?.place) { key = `p${m.location.place.id}`; g = { title: m.location.place.name, icon: m.location.place.icon, color: m.location.place.color }; }
    const cur = groups.get(key) ?? { ...g, people: [] };
    cur.people.push(m);
    groups.set(key, cur);
  }
  const order = [...groups.entries()].sort(([a], [b]) => (a.startsWith('p') ? 0 : a === 'away' ? 1 : 2) - (b.startsWith('p') ? 0 : b === 'away' ? 1 : 2));
  return (
    <div className="mx-auto grid max-w-2xl gap-3 p-3 sm:p-4" data-testid="board">
      {order.map(([key, g]) => (
        <div key={key} className="rounded-2xl border border-border bg-surface p-4 shadow-card">
          <div className="mb-3 flex items-center gap-3">
            {key === 'paused' ? (
              <span className="flex size-10 items-center justify-center rounded-[30%] bg-surface-2 text-muted"><MapPinOff size={20} /></span>
            ) : (
              <PlaceTile icon={g.icon} color={g.color} size={40} />
            )}
            <div className="min-w-0">
              <p className="truncate font-semibold text-fg">{g.title}</p>
              <p className="text-xs text-muted">{g.people.length} {g.people.length === 1 ? 'person' : 'people'}</p>
            </div>
          </div>
          <ul className="-mx-3 flex flex-col">
            {g.people.map((m) => (
              <li key={m.id}><MemberRow m={m} meId={meId} now={now} /></li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
