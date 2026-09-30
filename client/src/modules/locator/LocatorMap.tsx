import 'leaflet/dist/leaflet.css';
import './locator.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import L from 'leaflet';
import { Circle, MapContainer, Marker, Polyline, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { readableOn } from '../../lib/color';
import { firstName, initials } from '../../lib/format';
import { cn } from '../../lib/cn';
import { PLACE_ICONS } from './placeIcons';
import { isLiveNow, isStale } from './geo';
import type { LatLng, LocMember, Place } from './types';

export type TileStatus = 'loading' | 'ok' | 'failed';

/** Last tile result in this tab, so maps opened later (dialogs) start in the right state. */
let lastKnownTiles: TileStatus = 'loading';
export const knownTileStatus = () => lastKnownTiles;

export interface FocusRequest {
  /** Change the key to trigger a new fly-to. */
  key: string;
  points: LatLng[];
  zoom?: number;
}

export interface LocatorMapProps {
  members: LocMember[];
  places: Place[];
  meId?: number | null;
  selectedMemberId?: number | null;
  selectedPlaceId?: number | null;
  path?: LatLng[] | null;
  pathColor?: string;
  draft?: { lat: number; lng: number; radius: number; color: string } | null;
  focus?: FocusRequest | null;
  picking?: boolean;
  onMapClick?: (p: LatLng) => void;
  onMemberClick?: (id: number) => void;
  onPlaceClick?: (id: number) => void;
  /** Tile availability (lifted so the page can show a notice / list view). */
  tileStatus: TileStatus;
  onTileStatus: (s: TileStatus) => void;
  /** Bump to retry loading tiles. */
  tileAttempt?: number;
  controls?: boolean;
  now: number;
  className?: string;
  children?: ReactNode;
  ariaLabel?: string;
}

const DEFAULT_CENTER: LatLng = { lat: 30.2896, lng: -97.7531 };

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Place icon SVG markup, rendered once at module load (outside React rendering). */
const ICON_SVG: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  if (typeof document === 'undefined') return out;
  const div = document.createElement('div');
  const root = createRoot(div);
  for (const p of PLACE_ICONS) {
    flushSync(() => root.render(<p.icon size={16} strokeWidth={2.4} aria-hidden />));
    out[p.key] = div.innerHTML;
  }
  root.unmount();
  return out;
})();

function memberIcon(m: LocMember, opts: { selected: boolean; stale: boolean; live: boolean; me: boolean; offset: number; hidden: boolean }) {
  const { bg, fg } = readableOn(m.color);
  const cls = cn('loc-pin', opts.selected && 'is-selected', opts.stale && 'is-stale', opts.hidden && 'is-hidden');
  const inner = m.avatar_url ? `<img src="${esc(m.avatar_url)}" alt="" />` : esc(initials(m.name));
  const html =
    `<div class="${cls}" style="--pin:${esc(bg)}">` +
    (opts.live ? '<span class="loc-pin__pulse"></span>' : '') +
    `<span class="loc-pin__bubble" style="background:${esc(bg)};color:${esc(fg)}">${inner}</span>` +
    (opts.live ? '<span class="loc-pin__dot"></span>' : '') +
    '<span class="loc-pin__tail"></span>' +
    `<span class="loc-pin__label">${esc(opts.me ? (opts.hidden ? 'You · hidden' : 'You') : firstName(m.name))}</span></div>`;
  return L.divIcon({ html, className: 'loc-divicon', iconSize: [48, 60], iconAnchor: [24 - opts.offset, 58] });
}

function placeMarkerIcon(p: Place, selected: boolean, showLabel: boolean) {
  const { bg, fg } = readableOn(p.color);
  const html =
    `<div class="${cn('loc-place', selected && 'is-selected')}" style="--place:${esc(p.color)}">` +
    `<span class="loc-place__icon" style="background:${esc(bg)};color:${esc(fg)}">${ICON_SVG[p.icon] ?? ICON_SVG.pin ?? ''}</span>` +
    (showLabel ? `<span class="loc-place__name">${esc(p.name)}</span>` : '') + '</div>';
  return L.divIcon({ html, className: 'loc-divicon', iconSize: [0, 0], iconAnchor: [0, 0] });
}

const draftIcon = (color: string) =>
  L.divIcon({
    html:
      '<div class="loc-draft"><svg width="36" height="48" viewBox="0 0 36 48" aria-hidden="true">' +
      `<path d="M18 47C18 47 34 29.5 34 17.5 34 8.4 26.8 1 18 1S2 8.4 2 17.5C2 29.5 18 47 18 47Z" fill="${esc(color)}" stroke="#fff" stroke-width="2.5"/>` +
      '<circle cx="18" cy="17.5" r="6" fill="#fff"/></svg></div>',
    className: 'loc-divicon',
    iconSize: [36, 48],
    iconAnchor: [18, 47],
  });

/** Pins stand ~60px above their point with a name label below; keep them inside the frame. */
const fitPadding = (map: L.Map) =>
  map.getSize().x < 500
    ? { paddingTopLeft: [56, 84] as [number, number], paddingBottomRight: [84, 40] as [number, number] }
    : { paddingTopLeft: [72, 84] as [number, number], paddingBottomRight: [100, 44] as [number, number] };

/** Offline fallback drawn as a Leaflet grid layer, so it pans and zooms with the map. */
function OfflineGrid() {
  const map = useMap();
  useEffect(() => {
    const Grid = L.GridLayer.extend({
      createTile() {
        const d = document.createElement('div');
        d.className = 'loc-grid-tile';
        return d;
      },
    });
    const layer = new (Grid as unknown as new (o: L.GridLayerOptions) => L.GridLayer)({ tileSize: 256, className: 'loc-grid-layer' });
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map]);
  return null;
}

/** Flies to the requested focus whenever its key changes; keeps the map sized to its box. */
function Controller({ focus }: { focus?: FocusRequest | null }) {
  const map = useMap();
  const first = useRef(true);
  const key = focus?.key;
  useEffect(() => {
    if (!focus || !focus.points.length) return;
    const animate = !first.current;
    first.current = false;
    if (focus.points.length === 1) {
      const z = focus.zoom ?? Math.max(map.getZoom(), 15);
      if (animate) map.flyTo(focus.points[0], z, { duration: 0.8 });
      else map.setView(focus.points[0], z);
    } else {
      const b = L.latLngBounds(focus.points.map((p) => [p.lat, p.lng] as [number, number]));
      const opts = { ...fitPadding(map), maxZoom: focus.zoom ?? 15 };
      if (animate) map.flyToBounds(b, { ...opts, duration: 0.8 });
      else map.fitBounds(b, opts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

/** MapContainer only applies className on mount; toggle state classes on the container instead. */
function ClassSync({ classes }: { classes: Record<string, boolean> }) {
  const map = useMap();
  const json = JSON.stringify(classes);
  useEffect(() => {
    const el = map.getContainer();
    for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, boolean>)) el.classList.toggle(k, v);
  }, [map, json]);
  return null;
}

function Events({ onClick, onZoom, onMove }: { onClick?: (p: LatLng) => void; onZoom: (z: number) => void; onMove: () => void }) {
  const map = useMapEvents({
    click: (e) => onClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }),
    zoomend: () => onZoom(map.getZoom()),
    moveend: onMove,
    resize: onMove,
  });
  useEffect(() => onZoom(map.getZoom()), [map, onZoom]);
  return null;
}

function Controls({ fitPoints }: { fitPoints: LatLng[] }) {
  const map = useMap();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    L.DomEvent.disableClickPropagation(ref.current);
    L.DomEvent.disableScrollPropagation(ref.current);
  }, []);
  const btn =
    'flex size-10 items-center justify-center text-fg transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring';
  return (
    <div ref={ref} className="absolute right-3 top-3 z-[500] flex flex-col gap-2">
      <div className="hidden flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lift sm:flex">
        <button type="button" className={btn} aria-label="Zoom in" onClick={() => map.zoomIn()}>
          <Plus size={18} />
        </button>
        <span className="h-px bg-border" />
        <button type="button" className={btn} aria-label="Zoom out" onClick={() => map.zoomOut()}>
          <Minus size={18} />
        </button>
      </div>
      {fitPoints.length > 0 && (
        <button
          type="button"
          className={cn(btn, 'rounded-xl border border-border bg-surface shadow-lift')}
          aria-label="Show everyone"
          title="Show everyone"
          onClick={() => {
            if (fitPoints.length === 1) map.flyTo(fitPoints[0], 15, { duration: 0.6 });
            else map.flyToBounds(L.latLngBounds(fitPoints.map((p) => [p.lat, p.lng] as [number, number])), { ...fitPadding(map), maxZoom: 15, duration: 0.6 });
          }}
        >
          <Maximize2 size={17} />
        </button>
      )}
    </div>
  );
}

export function LocatorMap({
  members, places, meId, selectedMemberId, selectedPlaceId, path, pathColor = '#5B5BD6', draft, focus, picking,
  onMapClick, onMemberClick, onPlaceClick, tileStatus, onTileStatus, tileAttempt = 0, controls = true, now, className, children,
  ariaLabel = 'Family map',
}: LocatorMapProps) {
  const [zoom, setZoom] = useState(13);
  const [moveTick, setMoveTick] = useState(0);
  const bumpMove = useCallback(() => setMoveTick((n) => n + 1), []);
  const statusRef = useRef(tileStatus);
  statusRef.current = tileStatus;
  const onTileStatusRaw = onTileStatus;
  onTileStatus = useCallback((s: TileStatus) => {
    if (s !== 'loading') lastKnownTiles = s;
    onTileStatusRaw(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTileStatusRaw]);

  // Tile failure detection: any successful tile → ok; errors (or silence) without a success → failed.
  useEffect(() => {
    if (tileAttempt === 0 && lastKnownTiles === 'failed') {
      onTileStatus('failed');
      return;
    }
    onTileStatus('loading');
    const t = setTimeout(() => {
      if (statusRef.current === 'loading') onTileStatus('failed');
    }, 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileAttempt]);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);
  const tileEvents = useMemo(
    () => ({
      tileload: () => {
        if (statusRef.current !== 'ok') onTileStatus('ok');
      },
      tileerror: () => {
        if (statusRef.current !== 'loading' || errorTimer.current) return;
        errorTimer.current = setTimeout(() => {
          errorTimer.current = null;
          if (statusRef.current === 'loading') onTileStatus('failed');
        }, 1200);
      },
    }),
    [onTileStatus],
  );

  const located = members.filter((m) => m.location);

  const fitPoints = useMemo(() => {
    const pts: LatLng[] = located.map((m) => ({ lat: m.location!.lat, lng: m.location!.lng }));
    return pts.length ? pts : places.map((p) => ({ lat: p.lat, lng: p.lng }));
  }, [located, places]);

  const selected = located.find((m) => m.id === selectedMemberId);

  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={13}
      zoomControl={false}
      attributionControl
      className={cn('loc-map size-full', className)}
      aria-label={ariaLabel}
    >
      {tileStatus === 'failed' && <OfflineGrid />}
      {tileStatus !== 'failed' && (
        <TileLayer
          className="loc-osm-tiles"
          key={tileAttempt}
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          maxZoom={19}
          eventHandlers={tileEvents}
        />
      )}
      <Controller focus={focus} />
      <ClassSync classes={{ 'loc-map--grid': tileStatus === 'failed', 'is-picking': !!picking, 'is-zoomed-out': zoom < 13 }} />
      <Events onClick={onMapClick} onZoom={setZoom} onMove={bumpMove} />
      {controls && <Controls fitPoints={fitPoints} />}

      {places.map((p) => (
        <Circle
          key={`c${p.id}`}
          center={[p.lat, p.lng]}
          radius={p.radius}
          pathOptions={{
            color: p.color,
            weight: p.id === selectedPlaceId ? 3 : 2,
            fillColor: p.color,
            fillOpacity: p.id === selectedPlaceId ? 0.22 : 0.12,
            dashArray: p.id === selectedPlaceId ? undefined : '6 6',
          }}
          eventHandlers={{ click: (e) => { if (onPlaceClick && !picking) { L.DomEvent.stopPropagation(e); onPlaceClick(p.id); } } }}
        />
      ))}
      {selected?.location?.accuracy ? (
        <Circle
          center={[selected.location.lat, selected.location.lng]}
          radius={selected.location.accuracy}
          interactive={false}
          pathOptions={{ color: selected.color, weight: 1, fillColor: selected.color, fillOpacity: 0.1 }}
        />
      ) : null}

      {path && path.length > 1 && (
        <>
          <Polyline positions={path.map((p) => [p.lat, p.lng])} pathOptions={{ color: '#fff', weight: 7, opacity: 0.9 }} interactive={false} />
          <Polyline positions={path.map((p) => [p.lat, p.lng])} pathOptions={{ color: pathColor, weight: 4, opacity: 0.95, dashArray: '1 8', lineCap: 'round' }} interactive={false} />
        </>
      )}

      {draft && (
        <>
          <Circle center={[draft.lat, draft.lng]} radius={draft.radius} interactive={false} pathOptions={{ color: draft.color, weight: 2, fillColor: draft.color, fillOpacity: 0.18 }} />
          <Marker position={[draft.lat, draft.lng]} icon={draftIcon(draft.color)} interactive={false} keyboard={false} />
        </>
      )}

      <Pins
        members={located}
        places={places}
        meId={meId ?? null}
        selectedMemberId={selectedMemberId ?? null}
        selectedPlaceId={selectedPlaceId ?? null}
        zoom={zoom}
        moveTick={moveTick}
        controls={controls}
        now={now}
        onMemberClick={picking ? undefined : onMemberClick}
        onPlaceClick={picking ? undefined : onPlaceClick}
      />
      {children}
    </MapContainer>
  );
}

interface Box { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Member pins + place markers laid out in screen space for the current zoom:
 * - members at (nearly) the same spot fan out; a pin sitting on a place icon slides aside
 * - a place's name is hidden when someone is there (their row says it), at low zoom, or when it
 *   would collide with a pin or another label (bigger / selected places win)
 */
function Pins({ members, places, meId, selectedMemberId, selectedPlaceId, zoom, moveTick, controls, now, onMemberClick, onPlaceClick }: {
  members: LocMember[]; places: Place[]; meId: number | null; selectedMemberId: number | null; selectedPlaceId: number | null;
  zoom: number; moveTick: number; controls: boolean; now: number; onMemberClick?: (id: number) => void; onPlaceClick?: (id: number) => void;
}) {
  const map = useMap();
  const layout = useMemo(() => {
    const px = (p: LatLng) => map.latLngToContainerPoint([p.lat, p.lng]);
    const size = map.getSize();
    const offsets = new Map<number, number>();
    // 1) fan out members standing together
    const groups: { pt: L.Point; ms: LocMember[] }[] = [];
    for (const m of members) {
      const pt = px(m.location!);
      // pins are ~46×60px and stand above their point: group any whose bubbles would touch
      const g = groups.find((grp) => Math.abs(grp.pt.x - pt.x) < 46 && Math.abs(grp.pt.y - pt.y) < 62);
      if (g) g.ms.push(m);
      else groups.push({ pt, ms: [m] });
    }
    // 2) …leaving the middle free when a place icon sits under the group (pins flank the icon)
    const placePts = places.map((p) => ({ p, pt: px(p) }));
    for (const g of groups) {
      const icon = placePts.find(({ pt: q }) => Math.abs(g.pt.x - q.x) < 34 && g.pt.y >= q.y - 16 && g.pt.y - 60 <= q.y + 16);
      if (!icon) {
        g.ms.forEach((m, i) => offsets.set(m.id, (i - (g.ms.length - 1) / 2) * 46));
        continue;
      }
      const dx = g.pt.x - icon.pt.x; // keep the icon centered between the pins
      g.ms.forEach((m, i) => {
        const side = (i % 2 === 0) === (dx >= 0) ? 1 : -1;
        offsets.set(m.id, side * (46 + 50 * Math.floor(i / 2)) - dx);
      });
    }
    // Keep every pin inside the frame (a fanned-out pin must not slide off the edge).
    for (const m of members) {
      const pt = px(m.location!);
      if (pt.x < 0 || pt.x > size.x) continue;
      const o = offsets.get(m.id) ?? 0;
      offsets.set(m.id, Math.min(Math.max(o, 28 - pt.x), size.x - 28 - pt.x));
    }
    // 3) place labels that fit
    const taken: Box[] = members.map((m) => {
      const pt = px(m.location!);
      return { x: pt.x - 30 + (offsets.get(m.id) ?? 0), y: pt.y - 60, w: 60, h: 82 };
    });
    for (const { pt } of placePts) taken.push({ x: pt.x - 16, y: pt.y - 16, w: 32, h: 32 });
    if (controls) taken.push({ x: size.x - 72, y: 0, w: 72, h: size.x < 400 ? 70 : 150 }); // zoom / fit buttons
    const inside = (b: Box) => b.x >= 4 && b.y >= 4 && b.x + b.w <= size.x - 4 && b.y + b.h <= size.y - 22;
    const occupied = new Set(members.map((m) => m.location!.place?.id).filter(Boolean) as number[]);
    const labels = new Map<number, boolean>();
    const order = [...placePts].sort((a, b) => Number(b.p.id === selectedPlaceId) - Number(a.p.id === selectedPlaceId) || b.p.radius - a.p.radius);
    for (const { p, pt } of order) {
      if (zoom < 13 || (occupied.has(p.id) && p.id !== selectedPlaceId)) {
        labels.set(p.id, false);
        continue;
      }
      const box = { x: pt.x + 20, y: pt.y - 11, w: p.name.length * 6.8 + 20, h: 22 };
      const fits = inside(box) && !taken.some((t) => overlaps(box, t));
      labels.set(p.id, fits || p.id === selectedPlaceId);
      if (fits) taken.push(box);
    }
    return { offsets, labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, members, places, zoom, moveTick, controls, selectedPlaceId]);

  return (
    <>
      {places.map((p) => (
        <PlaceMarker key={`p${p.id}`} place={p} selected={p.id === selectedPlaceId} showLabel={layout.labels.get(p.id) ?? true} onClick={onPlaceClick} />
      ))}
      {members.map((m) => (
        <MemberMarker
          key={`m${m.id}`}
          member={m}
          me={m.id === meId}
          selected={m.id === selectedMemberId}
          offset={layout.offsets.get(m.id) ?? 0}
          now={now}
          onClick={onMemberClick}
        />
      ))}
    </>
  );
}

function MemberMarker({ member, me, selected, offset, now, onClick }: {
  member: LocMember; me: boolean; selected: boolean; offset: number; now: number; onClick?: (id: number) => void;
}) {
  const loc = member.location!;
  const stale = isStale(loc, now);
  const live = isLiveNow(loc, now) && member.sharing;
  const hidden = !member.sharing;
  const icon = useMemo(
    () => memberIcon(member, { selected, stale, live, me, offset, hidden }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [member.name, member.color, member.avatar_url, selected, stale, live, me, offset, hidden],
  );
  const where = loc.place ? `at ${loc.place.name}` : 'location';
  return (
    <Marker
      position={[loc.lat, loc.lng]}
      icon={icon}
      zIndexOffset={selected ? 1000 : me ? 500 : 100}
      title={`${member.name} ${where}`}
      alt={`${member.name} ${where}`}
      keyboard
      eventHandlers={{ click: () => onClick?.(member.id), keypress: (e) => { if ((e.originalEvent as KeyboardEvent).key === 'Enter') onClick?.(member.id); } }}
    />
  );
}

function PlaceMarker({ place, selected, showLabel, onClick }: { place: Place; selected: boolean; showLabel: boolean; onClick?: (id: number) => void }) {
  const icon = useMemo(() => placeMarkerIcon(place, selected, showLabel), [place, selected, showLabel]);
  return (
    <Marker
      position={[place.lat, place.lng]}
      icon={icon}
      zIndexOffset={-100}
      title={place.name}
      alt={place.name}
      keyboard={!!onClick}
      interactive={!!onClick}
      eventHandlers={{ click: () => onClick?.(place.id) }}
    />
  );
}
