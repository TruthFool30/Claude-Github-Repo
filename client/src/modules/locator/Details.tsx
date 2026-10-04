import { useMemo } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Battery, BatteryMedium, Bell, BellOff, Crosshair, EyeOff, Footprints, History as HistoryIcon, LocateFixed, MapPin,
  MapPinCheck, MapPinPlus, MessageSquareQuote, Pencil, Radio, Route, Trash2, Users,
} from 'lucide-react';
import { format, isToday, isYesterday, startOfDay, subDays } from 'date-fns';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { firstName, fmtTime, plural } from '../../lib/format';
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, Menu, Skeleton, toast, useConfirm } from '../../ui';
import { ago, distanceMeters, fmtCoords, fmtDistance, fmtDuration, isLiveNow } from './geo';
import { EventRow, whereText } from './People';
import { PlaceTile } from './placeIcons';
import type { History, LocMember, Place, PlaceDetail, Visit } from './types';

export function dayKey(d: Date) {
  return format(d, 'yyyy-MM-dd');
}

export function dayBounds(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return { start, end: start + 864e5 };
}

export function visitsForDay(h: History | undefined, key: string): Visit[] {
  if (!h) return [];
  const { start, end } = dayBounds(key);
  return h.visits.filter((v) => Date.parse(v.start) < end && Date.parse(v.end) >= start);
}

function dayLabel(d: Date) {
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'EEE d');
}

function PanelBack({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="-ml-1 mb-3 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-semibold text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
      <ArrowLeft size={16} /> {label}
    </Link>
  );
}

// ---------------------------------------------------------------------------------------------

export function MemberDetail({
  member, meId, now, history, loading, day, onDay, onCenter, onCheckIn,
}: {
  member: LocMember;
  meId: number | null;
  now: number;
  history: History | undefined;
  loading: boolean;
  day: string;
  onDay: (key: string) => void;
  onCenter: () => void;
  onCheckIn: () => void;
}) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const isMe = member.id === meId;
  const w = whereText(member, meId, now);
  const loc = member.location;
  const live = member.sharing && isLiveNow(loc, now);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => subDays(startOfDay(new Date(now)), i)), [now]);
  const visits = visitsForDay(history, day).slice().reverse();
  const { start: dayStart } = dayBounds(day);
  const countsByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of days) m.set(dayKey(d), visitsForDay(history, dayKey(d)).length);
    return m;
  }, [days, history]);

  const clearHistory = async () => {
    const ok = await confirm({
      title: 'Clear your location history?',
      message: 'All your check-ins and arrivals in this family are deleted for everyone. Your current location disappears from the map until you check in again.',
      confirmLabel: 'Clear history',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del('/locator/history');
      await qc.invalidateQueries({ queryKey: ['locator'] });
      toast.success('Location history cleared');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const deleteVisit = async (v: Visit) => {
    const ok = await confirm({
      title: 'Delete this stop?',
      message: `${v.place?.name ?? 'This location'} (${fmtTime(v.start)}) will be removed from your history.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      for (const id of v.checkin_ids) await api.del(`/locator/checkins/${id}`);
      await qc.invalidateQueries({ queryKey: ['locator'] });
      toast.success('Stop deleted');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const hidden = history?.hidden || (!member.sharing && !isMe);

  return (
    <div className="animate-fade-in" data-testid="member-detail">
      <PanelBack to="/locator" label="Everyone" />
      <div className="flex items-start gap-4">
        <span className={cn(!member.sharing && 'opacity-70 grayscale')}>
          <Avatar user={member} size="xl" status={live ? 'online' : null} />
        </span>
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-xl font-bold tracking-tight text-fg">{isMe ? `${member.name} (you)` : member.name}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[15px] font-medium text-fg">
            {w.tone === 'paused' && <EyeOff size={15} className="text-muted" />}
            {w.title}
          </p>
          {w.detail && <p className="text-[13px] text-muted">{w.detail}</p>}
        </div>
      </div>

      {loc && !hidden && (
        <div className="mt-4 grid grid-cols-2 gap-2 text-[13px]">
          <div className="col-span-2 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-muted">
            <MapPin size={14} className="shrink-0" />
            <span className="truncate tabular">{fmtCoords(loc.lat, loc.lng)}</span>
            {loc.accuracy ? <span className="ml-auto shrink-0 text-subtle">±{fmtDistance(loc.accuracy)}</span> : null}
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-muted">
            {loc.source === 'live' ? <Radio size={14} /> : <MapPinCheck size={14} />}
            {loc.source === 'live' ? 'Live location' : 'Checked in'}
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-muted" title="Battery level shared by the device">
            {loc.battery == null ? <Battery size={14} /> : <BatteryMedium size={14} />}
            {loc.battery == null ? 'Battery N/A' : `Battery ${loc.battery}%`}
          </div>
          {loc.note && (
            <div className="col-span-2 flex items-start gap-2 rounded-xl border border-border px-3 py-2 text-fg">
              <MessageSquareQuote size={14} className="mt-0.5 shrink-0 text-muted" />
              <span>“{loc.note}”</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {loc && !hidden && <Button size="sm" variant="secondary" icon={Crosshair} onClick={onCenter}>Show on map</Button>}
        {isMe && member.sharing && <Button size="sm" icon={MapPinCheck} onClick={onCheckIn}>Check in</Button>}
        {isMe && (history?.checkins.length ?? 0) > 0 && (
          <Button size="sm" variant="ghost" icon={Trash2} className="text-danger" onClick={clearHistory}>Clear history</Button>
        )}
      </div>

      <div className="mt-6">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
          <HistoryIcon size={16} className="text-muted" /> Last 7 days
        </h3>
        {hidden ? (
          <EmptyState compact icon={EyeOff} accent="#8d90a0" title={`${firstName(member.name)} paused sharing`} description="Their location history is hidden until they turn sharing back on." />
        ) : (
          <>
            {history && (
              <div className="mb-3 grid grid-cols-3 gap-2">
                <Stat icon={MapPinCheck} label="Check-ins" value={String(history.stats.checkins)} />
                <Stat icon={MapPin} label="Places" value={String(history.stats.places_visited)} />
                <Stat icon={Route} label="Traveled" value={fmtDistance(history.stats.meters)} />
              </div>
            )}
            <div role="tablist" aria-label="Day" className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none">
              {days.map((d) => {
                const k = dayKey(d);
                const on = k === day;
                const n = countsByDay.get(k) ?? 0;
                return (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => onDay(k)}
                    className={cn(
                      'flex shrink-0 flex-col items-center rounded-xl px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                      on ? 'bg-primary-solid text-white shadow-card' : 'bg-surface-2 text-muted hover:text-fg',
                    )}
                  >
                    <span>{dayLabel(d)}</span>
                    <span className={cn('text-[10px] font-medium', on ? 'text-white/80' : 'text-subtle')}>{n ? plural(n, 'stop') : '—'}</span>
                  </button>
                );
              })}
            </div>
            {loading && !history ? (
              <div className="flex flex-col gap-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="size-9 rounded-xl" />
                    <div className="flex-1"><Skeleton className="mb-1.5 h-3.5 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>
                  </div>
                ))}
              </div>
            ) : visits.length === 0 ? (
              <EmptyState compact icon={Footprints} accent="#E5484D" title="No stops this day" description={isMe ? 'Check in or turn on live sharing to build your timeline.' : 'Nothing was shared on this day.'} />
            ) : (
              <ol className="relative" data-testid="timeline">
                {visits.map((v, i) => {
                  const current = i === 0 && isToday(new Date(dayStart)) && now - Date.parse(v.end) < 30 * 60e3 && v.checkin_ids.includes(loc?.checkin_id ?? -1);
                  const overnight = Date.parse(v.start) < dayStart;
                  const next = visits[i - 1];
                  const gap = next ? distanceMeters(v, next) : 0;
                  return (
                    <li key={`${v.start}-${v.checkin_ids[0]}`} className="relative flex gap-3 pb-4 last:pb-0">
                      {i < visits.length - 1 && <span className="absolute bottom-0 left-[18px] top-10 w-0.5 rounded-full bg-border" aria-hidden />}
                      {v.place ? <PlaceTile icon={v.place.icon} color={v.place.color} size={38} className="relative z-[1]" /> : (
                        <span className="relative z-[1] flex size-[38px] shrink-0 items-center justify-center rounded-[30%] bg-surface-2 text-muted ring-1 ring-border"><MapPin size={17} /></span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-semibold text-fg">
                              <span className="truncate">{v.place ? v.place.name : fmtCoords(v.lat, v.lng, 4)}</span>
                              {current && <Badge tone="success" size="sm" dot>Now</Badge>}
                              {v.checked_in && <Badge tone="danger" size="sm"><MapPinCheck size={10} /> Checked in</Badge>}
                            </p>
                            <p className="text-[13px] tabular text-muted">
                              {overnight ? 'Overnight' : fmtTime(v.start)} – {current ? 'now' : fmtTime(v.end)}
                              <span className="text-subtle"> · {fmtDuration(v.start, current ? new Date(now).toISOString() : v.end)}</span>
                            </p>
                          </div>
                          {isMe && (
                            <Menu
                              label={`Actions for stop at ${fmtTime(v.start)}`}
                              items={[{ label: 'Delete this stop', icon: Trash2, danger: true, onSelect: () => deleteVisit(v) }]}
                            />
                          )}
                        </div>
                        {v.note && <p className="mt-1.5 inline-block rounded-xl rounded-tl-sm bg-surface-2 px-3 py-1.5 text-[13px] text-fg">“{v.note}”</p>}
                        {next && gap > 200 && (
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-subtle"><Route size={12} /> {fmtDistance(gap)} to next stop</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof MapPin; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <p className="flex items-center gap-1 text-[11px] font-semibold text-subtle whitespace-nowrap"><Icon size={11} /> {label}</p>
      <p className="mt-0.5 text-lg font-bold tabular text-fg">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function PlacesList({
  places, members, meId, canManage, onAdd, onEdit, onDelete, selectedId,
}: {
  places: Place[];
  members: LocMember[];
  meId: number | null;
  canManage: (p: Place) => boolean;
  onAdd: () => void;
  onEdit: (p: Place) => void;
  onDelete: (p: Place) => void;
  selectedId?: number | null;
}) {
  if (!places.length) {
    return (
      <EmptyState
        compact
        icon={MapPinPlus}
        accent="#E5484D"
        title="No places yet"
        description="Save Home, School or Work to see who’s where and get arrival alerts."
        action={<Button icon={MapPinPlus} onClick={onAdd}>Add a place</Button>}
      />
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="places-list">
      {places.map((p) => {
        const here = members.filter((m) => m.location?.place?.id === p.id && (m.sharing || m.id === meId));
        return (
          <li key={p.id} className={cn('group flex items-center gap-1 rounded-2xl pr-1 transition hover:bg-surface-2', selectedId === p.id && 'bg-surface-2')}>
            <Link
              to={`/locator/places/${p.id}`}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
              aria-label={`${p.name}${here.length ? `, ${here.length} here now` : ''}`}
            >
              <PlaceTile icon={p.icon} color={p.color} size={42} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-fg">
                  <span className="truncate">{p.name}</span>
                  {!p.notify && <BellOff size={13} className="shrink-0 text-subtle" aria-label="Alerts off" />}
                </p>
                <p className="truncate text-[13px] text-muted">{p.address || `${fmtDistance(p.radius)} radius`}</p>
              </div>
              {here.length > 0 && <AvatarStack users={here} size="sm" max={3} />}
            </Link>
            {canManage(p) && (
              <Menu
                label={`Actions for ${p.name}`}
                items={[
                  { label: 'Edit place', icon: Pencil, onSelect: () => onEdit(p) },
                  'divider',
                  { label: 'Delete place', icon: Trash2, danger: true, onSelect: () => onDelete(p) },
                ]}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PlacePanel({
  place, detail, members, meId, now, canManage, onEdit, onDelete, onCenter,
}: {
  place: Place;
  detail: PlaceDetail | undefined;
  members: LocMember[];
  meId: number | null;
  now: number;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCenter: () => void;
}) {
  const here = members.filter((m) => m.location?.place?.id === place.id && (m.sharing || m.id === meId));
  return (
    <div className="animate-fade-in" data-testid="place-detail">
      <PanelBack to="/locator/places" label="Places" />
      <div className="flex items-start gap-4">
        <PlaceTile icon={place.icon} color={place.color} size={64} />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-xl font-bold tracking-tight text-fg">{place.name}</h2>
          <p className="text-[13px] text-muted">{place.address || fmtCoords(place.lat, place.lng, 4)}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone="neutral">{fmtDistance(place.radius)} radius</Badge>
            {place.notify ? <Badge tone="success"><Bell size={10} /> Alerts on</Badge> : <Badge tone="neutral"><BellOff size={10} /> Alerts off</Badge>}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={LocateFixed} onClick={onCenter}>Show on map</Button>
        {canManage && <Button size="sm" variant="secondary" icon={Pencil} onClick={onEdit}>Edit</Button>}
        {canManage && <IconButton icon={Trash2} label={`Delete ${place.name}`} variant="ghost" className="text-danger" onClick={onDelete} />}
      </div>

      <h3 className="mb-2 mt-6 flex items-center gap-2 text-sm font-semibold text-fg"><Users size={16} className="text-muted" /> Here now</h3>
      {here.length ? (
        <ul className="flex flex-col gap-2">
          {here.map((m) => (
            <li key={m.id}>
              <Link to={`/locator/member/${m.id}`} className="flex items-center gap-3 rounded-xl px-1 py-1 transition hover:bg-surface-2">
                <Avatar user={m} size="md" />
                <span className="flex-1 truncate text-sm font-semibold text-fg">{m.id === meId ? 'You' : m.name}</span>
                <span className="text-xs text-muted">{m.location?.since ? `since ${fmtTime(m.location.since)}` : ago(m.location!.updated_at, now)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-muted">Nobody is here right now.</p>
      )}

      <h3 className="mb-1 mt-6 flex items-center gap-2 text-sm font-semibold text-fg"><HistoryIcon size={16} className="text-muted" /> Arrivals & departures · 7 days</h3>
      {!detail ? (
        <div className="flex flex-col gap-2 pt-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7" />)}</div>
      ) : detail.events.length ? (
        <ul className="divide-y divide-border">{detail.events.map((e) => <EventRow key={e.id} e={e} now={now} />)}</ul>
      ) : (
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-muted">No visits in the last week.</p>
      )}
    </div>
  );
}
