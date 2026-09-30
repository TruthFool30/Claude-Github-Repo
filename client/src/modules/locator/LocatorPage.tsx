import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Popup } from 'react-leaflet';
import { List, Map as MapIcon, MapPinCheck, MapPinPlus, RefreshCw, UserX, WifiOff, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useLive } from '../../lib/live';
import { useIsDesktop } from '../../lib/hooks';
import { plural } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  Button, Card, EmptyState, IconButton, PageHeader, SegmentedControl, Skeleton, SkeletonList, Tabs, toast, useConfirm,
} from '../../ui';
import mod from './index';
import { CheckInDialog } from './CheckInDialog';
import { MemberDetail, PlacePanel, PlacesList, dayBounds, dayKey } from './Details';
import { OVERVIEW_KEY, useHistory, useNow, useOverview, usePlaceDetail, usePlaceMutations, useSharingMutation } from './data';
import { fmtCoords } from './geo';
import { LocatorMap, knownTileStatus, type FocusRequest, type TileStatus } from './LocatorMap';
import { startLiveShare, stopLiveShare, useLiveShare } from './liveShare';
import { Board, EventRow, MemberRow, SharingCard } from './People';
import { PlaceDialog } from './PlaceDialog';
import type { LatLng, Place } from './types';

type Route = { kind: 'people' } | { kind: 'places' } | { kind: 'place'; id: number } | { kind: 'member'; id: number };

function parseRoute(rest: string): Route {
  const [a, b] = rest.split('/').filter(Boolean);
  const id = Number(b);
  if (a === 'places' && Number.isInteger(id) && id > 0) return { kind: 'place', id };
  if (a === 'places') return { kind: 'places' };
  if (a === 'member' && Number.isInteger(id) && id > 0) return { kind: 'member', id };
  return { kind: 'people' };
}

export default function LocatorPage() {
  const params = useParams();
  const route = parseRoute(params['*'] ?? '');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user, familyId, role } = useAuth();
  const meId = user?.id ?? null;
  const overview = useOverview();
  useLive('locator');
  const now = useNow();
  const live = useLiveShare();
  const sharingMut = useSharingMutation();
  const { remove } = usePlaceMutations();

  const [tileStatus, setTileStatus] = useState<TileStatus>(knownTileStatus);
  const [tileAttempt, setTileAttempt] = useState(0);
  // On phones the notice starts collapsed to a small chip so it doesn't cover the pins.
  const [noticeOpen, setNoticeOpen] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 640px)').matches);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [placeDialog, setPlaceDialog] = useState<{ open: boolean; place: Place | null; initial: LatLng | null }>({ open: false, place: null, initial: null });
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [clickPoint, setClickPoint] = useState<LatLng | null>(null);
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [focusNonce, setFocusNonce] = useState(0);

  // Live sharing belongs to one family: stop it when this tab switches family or signs out.
  useEffect(() => {
    if (live.active && live.familyId !== familyId) stopLiveShare();
  }, [familyId, live.active, live.familyId]);

  const data = overview.data;
  const members = useMemo(() => data?.members ?? [], [data]);
  const places = useMemo(() => data?.places ?? [], [data]);
  const me = members.find((m) => m.id === meId);
  const sharing = data?.me.sharing ?? true;

  const memberId = route.kind === 'member' ? route.id : null;
  const placeId = route.kind === 'place' ? route.id : null;
  const member = memberId ? members.find((m) => m.id === memberId) : undefined;
  const place = placeId ? places.find((p) => p.id === placeId) : undefined;
  const history = useHistory(memberId);
  const placeDetail = usePlaceDetail(placeId);

  useEffect(() => setDay(dayKey(new Date())), [memberId]);
  useEffect(() => setClickPoint(null), [route.kind, memberId, placeId]);

  // Path of the selected member on the selected day.
  const path = useMemo(() => {
    if (!history.data || history.data.hidden) return null;
    const { start, end } = dayBounds(day);
    return history.data.checkins
      .filter((c) => Date.parse(c.created_at) < end && Date.parse(c.updated_at) >= start)
      .map((c) => ({ lat: c.lat, lng: c.lng }));
  }, [history.data, day]);

  const focus: FocusRequest | null = useMemo(() => {
    if (!data) return null;
    if (route.kind === 'member' && member) {
      const isToday = day === dayKey(new Date());
      const route = [...(path ?? []), ...(isToday && member.location ? [member.location] : [])];
      if (route.length > 1) return { key: `m${member.id}-${day}-${focusNonce}-${route.length}`, points: route, zoom: 15 };
      if (member.location) return { key: `m${member.id}-${day}-${focusNonce}`, points: [member.location], zoom: 15 };
      if (path && path.length) return { key: `m${member.id}-${day}-${focusNonce}`, points: path, zoom: 15 };
    }
    if (route.kind === 'place' && place) {
      const z = place.radius > 600 ? 14 : place.radius > 250 ? 15 : 16;
      return { key: `p${place.id}-${focusNonce}`, points: [place], zoom: z };
    }
    const pts = members.filter((m) => m.location).map((m) => m.location!) as LatLng[];
    return { key: `all-${focusNonce}`, points: pts.length ? pts : places.length ? places : [{ lat: 30.2896, lng: -97.7531 }], zoom: 14 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data, route.kind, memberId, placeId, day, focusNonce, !!member?.location, !!place, path?.length]);

  const isDesktop = useIsDesktop();
  const inDetail = route.kind === 'member' || route.kind === 'place';
  const mapCardRef = useRef<HTMLDivElement>(null);
  // Phones: a member/place opens with the page header collapsed, so the (shorter) map sits right
  // under the top bar and the detail starts below it — no scrolling under the translucent bar.
  const compact = inDetail && !isDesktop;

  const canManage = useCallback((p: Place) => role !== 'child' || p.created_by === meId, [role, meId]);

  const openCheckin = () => setCheckinOpen(true);
  const addPlace = (initial: LatLng | null = null) => setPlaceDialog({ open: true, place: null, initial });
  const editPlace = (p: Place) => setPlaceDialog({ open: true, place: p, initial: null });
  const deletePlace = async (p: Place) => {
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      message: 'The circle disappears from the map and arrival alerts stop. Past check-ins stay in everyone’s history.',
      confirmLabel: 'Delete place',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(p.id, { onSuccess: () => toast.success(`${p.name} deleted`) });
    if (placeId === p.id) navigate('/locator/places');
  };

  const toggleSharing = (v: boolean) => {
    if (!v && live.active) stopLiveShare();
    sharingMut.mutate(v); // the sharing card itself shows the new state
  };
  const announceLive = useRef(false);
  const toggleLive = (v: boolean) => {
    if (!v) {
      announceLive.current = false;
      stopLiveShare();
      return;
    }
    if (!familyId) return;
    announceLive.current = true;
    startLiveShare(familyId, () => qc.invalidateQueries({ queryKey: OVERVIEW_KEY }));
  };
  // Confirm only once a position was actually sent (not when permission is denied).
  useEffect(() => {
    if (!announceLive.current) return;
    if (live.lastSentAt) {
      announceLive.current = false;
      toast.success('Sharing your live location', { description: 'Updates are sent while Hearth is open in this tab.' });
    } else if (!live.active) {
      announceLive.current = false;
    }
  }, [live.lastSentAt, live.active]);

  const sharingCount = members.filter((m) => m.sharing && m.location).length;
  const subtitle = data ? `${sharingCount} of ${plural(members.length, 'person', 'people')} sharing · ${plural(places.length, 'place')}` : 'Where everyone is';

  if (overview.isError && !data) {
    return (
      <div>
        <PageHeader title={mod.label} subtitle="Where everyone is" icon={mod.icon} accent={mod.accent} />
        <Card>
          <EmptyState icon={WifiOff} accent={mod.accent} title="Couldn’t load locations" description="Check your connection and try again." action={<Button icon={RefreshCw} onClick={() => overview.refetch()}>Try again</Button>} />
        </Card>
      </div>
    );
  }

  const tilesFailed = tileStatus === 'failed';

  const panel = !data ? (
    <div className="p-1"><SkeletonList rows={4} /></div>
  ) : route.kind === 'member' ? (
    member ? (
      <MemberDetail
        member={member}
        meId={meId}
        now={now}
        history={history.data}
        loading={history.isLoading}
        day={day}
        onDay={setDay}
        onCenter={() => setFocusNonce((n) => n + 1)}
        onCheckIn={openCheckin}
      />
    ) : (
      <EmptyState compact icon={UserX} accent={mod.accent} title="Member not found" description="They may have left the family." action={<Button variant="secondary" onClick={() => navigate('/locator')}>Back to everyone</Button>} />
    )
  ) : route.kind === 'place' ? (
    place ? (
      <PlacePanel
        place={place}
        detail={placeDetail.data}
        members={members}
        meId={meId}
        now={now}
        canManage={canManage(place)}
        onEdit={() => editPlace(place)}
        onDelete={() => deletePlace(place)}
        onCenter={() => setFocusNonce((n) => n + 1)}
      />
    ) : (
      <EmptyState compact icon={MapPinPlus} accent={mod.accent} title="Place not found" description="It may have been deleted." action={<Button variant="secondary" onClick={() => navigate('/locator/places')}>All places</Button>} />
    )
  ) : (
    <div className="animate-fade-in">
      <Tabs
        className="mb-3"
        accent={mod.accent}
        value={route.kind}
        onChange={(id) => navigate(id === 'places' ? '/locator/places' : '/locator')}
        tabs={[
          { id: 'people', label: 'People', count: members.length },
          { id: 'places', label: 'Places', count: places.length },
        ]}
      />
      {route.kind === 'people' ? (
        <div className="flex flex-col gap-4">
          <SharingCard me={me} sharing={sharing} onToggleSharing={toggleSharing} live={live} onToggleLive={toggleLive} onCheckIn={openCheckin} now={now} busy={sharingMut.isPending} />
          {view === 'map' && (
            <ul className="-mx-2 flex flex-col" aria-label="Family members">
              {members.map((m) => (
                <li key={m.id}><MemberRow m={m} meId={meId} now={now} /></li>
              ))}
            </ul>
          )}
          <div>
            <h3 className="mb-1 text-sm font-semibold text-fg">Recent arrivals & departures</h3>
            {data.recent.length ? (
              <ul className="divide-y divide-border" data-testid="recent-events">{data.recent.slice(0, 8).map((e) => <EventRow key={e.id} e={e} now={now} />)}</ul>
            ) : (
              <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-muted">No comings and goings in the last two days.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <PlacesList places={places} members={members} meId={meId} canManage={canManage} onAdd={() => addPlace()} onEdit={editPlace} onDelete={deletePlace} selectedId={placeId} />
          {places.length > 0 && (
            <Button variant="soft" icon={MapPinPlus} onClick={() => addPlace()} block>Add a place</Button>
          )}
          <p className="px-1 text-center text-xs text-subtle">Tip: click anywhere on the map to add a place there.</p>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        className={compact ? 'hidden' : undefined}
        documentTitle={mod.label}
        title={mod.label}
        subtitle={subtitle}
        icon={mod.icon}
        accent={mod.accent}
        actions={
          <>
            <SegmentedControl
              size="sm"
              aria-label="View"
              value={view}
              onChange={setView}
              options={[
                { value: 'map', label: 'Map', icon: MapIcon },
                { value: 'list', label: 'List', icon: List },
              ]}
            />
            <span className="hidden sm:contents">
              <Button variant="secondary" icon={MapPinPlus} onClick={() => addPlace()}>Add place</Button>
            </span>
            <span className="contents sm:hidden">
              <IconButton icon={MapPinPlus} label="Add place" variant="secondary" onClick={() => addPlace()} />
            </span>
            <span className="hidden lg:contents">
              <Button icon={MapPinCheck} onClick={openCheckin}>Check in</Button>
            </span>
            <span className="contents lg:hidden">
              <IconButton icon={MapPinCheck} label="Check in" variant="primary" onClick={openCheckin} />
            </span>
          </>
        }
      />

      <div className="flex flex-col gap-4 lg:grid lg:h-[calc(100dvh-var(--shell-chrome)-84px)] lg:min-h-[540px] lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-5">
        <Card
          ref={mapCardRef}
          padding="none"
          className={cn('relative isolate min-h-[260px] overflow-hidden rounded-3xl transition-[height] duration-300 lg:h-full', inDetail ? 'h-[36dvh]' : 'h-[46dvh]')}
        >
          {!data ? (
            <Skeleton className="size-full rounded-none" />
          ) : view === 'list' ? (
            <div className="size-full overflow-y-auto bg-bg/40">
              <Board members={members} meId={meId} now={now} />
            </div>
          ) : (
            <>
              <LocatorMap
                members={members.filter((m) => m.sharing || m.id === meId)}
                places={places}
                meId={meId}
                selectedMemberId={memberId}
                selectedPlaceId={placeId}
                path={route.kind === 'member' ? path : null}
                pathColor={member?.color}
                focus={focus}
                onMapClick={(p) => setClickPoint(p)}
                onMemberClick={(id) => navigate(`/locator/member/${id}`)}
                onPlaceClick={(id) => navigate(`/locator/places/${id}`)}
                tileStatus={tileStatus}
                onTileStatus={setTileStatus}
                tileAttempt={tileAttempt}
                now={now}
              >
                {clickPoint && (
                  <Popup position={clickPoint} eventHandlers={{ remove: () => setClickPoint(null) }}>
                    <div className="flex flex-col gap-2" data-testid="map-popup">
                      <span className="text-xs tabular text-muted">{fmtCoords(clickPoint.lat, clickPoint.lng, 4)}</span>
                      <Button
                        size="sm"
                        icon={MapPinPlus}
                        onClick={() => {
                          addPlace(clickPoint);
                          setClickPoint(null);
                        }}
                      >
                        Add a place here
                      </Button>
                    </div>
                  </Popup>
                )}
              </LocatorMap>
              {tilesFailed && (
                noticeOpen ? (
                  <div role="status" className="absolute left-3 top-3 z-[500] max-w-[calc(100%-5.5rem)] animate-fade-in rounded-2xl border border-border bg-surface/95 p-3 shadow-lift backdrop-blur sm:max-w-sm" data-testid="tiles-notice">
                    <div className="flex items-start gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-warning-soft text-warning-soft-fg"><WifiOff size={16} /></span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-fg">Street map unavailable</p>
                        <p className="hidden text-xs text-muted sm:block">You’re offline or the map server can’t be reached. People and places are shown on a simple grid.</p>
                        <p className="text-xs text-muted sm:hidden">Showing a simple grid instead.</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Button size="sm" variant="secondary" icon={List} onClick={() => setView('list')}>List view</Button>
                          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => setTileAttempt((n) => n + 1)}>Retry</Button>
                        </div>
                      </div>
                      <button type="button" aria-label="Hide notice" onClick={() => setNoticeOpen(false)} className="-mr-1 -mt-1 rounded-lg p-1 text-subtle transition hover:bg-surface-2 hover:text-fg">
                        <X size={15} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setNoticeOpen(true)} className="absolute left-3 top-3 z-[500] inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-xs font-semibold text-muted shadow-card">
                    <WifiOff size={13} /> Offline map
                  </button>
                )
              )}
            </>
          )}
        </Card>

        <Card padding="none" className={cn('p-4 sm:p-5 lg:h-full lg:overflow-y-auto')} aria-label="Locator details">
          {panel}
        </Card>
      </div>


      <PlaceDialog
        open={placeDialog.open}
        onClose={() => setPlaceDialog((s) => ({ ...s, open: false }))}
        place={placeDialog.place}
        initial={placeDialog.initial}
        places={places}
        members={members}
        now={now}
        onSaved={(p) => {
          if (!placeDialog.place) navigate(`/locator/places/${p.id}`);
        }}
      />
      <CheckInDialog open={checkinOpen} onClose={() => setCheckinOpen(false)} places={places} sharing={sharing} now={now} />
    </div>
  );
}
