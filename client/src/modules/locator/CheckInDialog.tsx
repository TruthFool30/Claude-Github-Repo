import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, MapPinCheck, Pause, Play, RefreshCw } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { Button, Field, Modal, Spinner, Textarea, toast } from '../../ui';
import { getPosition, readBattery, useCheckinMutation, useSharingMutation, type GeoFix } from './data';
import { distanceMeters, fmtCoords, fmtDistance } from './geo';
import { LocatorMap, knownTileStatus, type TileStatus } from './LocatorMap';
import { PlaceTile } from './placeIcons';
import type { LatLng, Place } from './types';

export interface CheckInDialogProps {
  open: boolean;
  onClose: () => void;
  places: Place[];
  sharing: boolean;
  now: number;
  onDone?: () => void;
}

/** Which saved place contains a point (closest relative to its radius). */
function containing(places: Place[], p: LatLng) {
  let best: { place: Place; meters: number } | null = null;
  let score = Infinity;
  for (const place of places) {
    const d = distanceMeters(place, p);
    if (d <= place.radius && d / place.radius < score) {
      score = d / place.radius;
      best = { place, meters: d };
    }
  }
  return best;
}

export function CheckInDialog({ open, onClose, places, sharing, now, onDone }: CheckInDialogProps) {
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [manual, setManual] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [tiles, setTiles] = useState<TileStatus>(knownTileStatus);
  const [focusKey, setFocusKey] = useState(0);
  const checkin = useCheckinMutation();
  const sharingMut = useSharingMutation();

  const locate = async () => {
    setLocating(true);
    setGeoError(null);
    try {
      const f = await getPosition();
      setFix(f);
      setManual(false);
      setFocusKey((k) => k + 1);
    } catch (e) {
      setGeoError(errorMessage(e));
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setFix(null);
    setNote('');
    setManual(false);
    setGeoError(null);
    if (sharing) void locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const inside = fix ? containing(places, fix) : null;
  const nearest = fix && !inside
    ? places.map((p) => ({ place: p, meters: distanceMeters(p, fix) })).sort((a, b) => a.meters - b.meters)[0] ?? null
    : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!fix) return;
    try {
      const battery = await readBattery();
      const res = await checkin.mutateAsync({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, note: note.trim() || null, battery });
      const arrived = res.transitions.find((t) => t.kind === 'arrived');
      toast.success(arrived ? `Checked in at ${arrived.place_name}` : inside ? `Checked in at ${inside.place.name}` : 'Checked in', {
        description: 'Your family can see where you are.',
      });
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const center = fix ?? (places[0] ? { lat: places[0].lat, lng: places[0].lng } : { lat: 30.2896, lng: -97.7531 });

  return (
    <Modal
      open={open}
      onClose={() => !checkin.isPending && onClose()}
      title="Check in"
      description={sharing ? 'Share where you are right now with the family.' : undefined}
      icon={
        <span className="flex size-10 items-center justify-center rounded-2xl bg-danger-soft text-danger-soft-fg">
          <MapPinCheck size={20} />
        </span>
      }
      footer={
        sharing ? (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="checkin-form" icon={MapPinCheck} loading={checkin.isPending} disabled={!fix}>
              Check in
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Not now</Button>
            <Button icon={Play} loading={sharingMut.isPending} onClick={() => sharingMut.mutate(true, { onSuccess: () => void locate() })}>
              Resume sharing
            </Button>
          </>
        )
      }
    >
      {!sharing ? (
        <div className="flex items-start gap-3 rounded-2xl bg-warning-soft p-4 text-warning-soft-fg">
          <Pause size={20} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Location sharing is paused</p>
            <p className="mt-0.5 text-sm opacity-90">Resume sharing to check in. Your family can’t see your location while it’s paused.</p>
          </div>
        </div>
      ) : (
        <form id="checkin-form" onSubmit={submit} className="flex flex-col gap-4">
          <div className="relative isolate h-48 overflow-hidden rounded-2xl border border-border">
            {open && (
              <LocatorMap
                members={[]}
                places={places}
                draft={fix ? { lat: fix.lat, lng: fix.lng, radius: Math.max(15, Math.min(fix.accuracy ?? 25, 400)), color: '#E5484D' } : null}
                focus={{ key: `c${focusKey}`, points: [center], zoom: 15 }}
                picking={manual}
                onMapClick={manual ? (p) => setFix({ ...p, accuracy: null }) : undefined}
                controls={false}
                tileStatus={tiles}
                onTileStatus={setTiles}
                now={now}
                ariaLabel="Your check-in location"
              />
            )}
            {locating && (
              <div className="absolute inset-0 z-[500] flex flex-col items-center justify-center gap-2 bg-surface/70 text-sm font-semibold text-fg backdrop-blur-sm">
                <Spinner />
                Finding you…
              </div>
            )}
            {manual && (
              <div className="pointer-events-none absolute inset-x-3 top-3 z-[500] flex justify-center">
                <span className="rounded-full bg-surface/95 px-3 py-1.5 text-[12px] font-semibold text-fg shadow-lift ring-1 ring-border">
                  Tap the map where you are
                </span>
              </div>
            )}
          </div>

          {geoError && !fix && (
            <div role="alert" className="flex items-start gap-3 rounded-2xl bg-danger-soft p-3.5 text-danger-soft-fg">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{geoError}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" icon={RefreshCw} onClick={locate}>Try again</Button>
                  <Button size="sm" variant="ghost" onClick={() => setManual(true)}>Pick on the map</Button>
                </div>
              </div>
            </div>
          )}

          {fix && (
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-2/50 p-3" data-testid="checkin-summary">
              {inside ? <PlaceTile icon={inside.place.icon} color={inside.place.color} size={44} /> : <PlaceTile icon="pin" color="#E5484D" size={44} />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-fg">
                  {inside ? `You’re at ${inside.place.name}` : nearest && nearest.meters < 5000 ? `${fmtDistance(nearest.meters)} from ${nearest.place.name}` : 'You’re here'}
                </p>
                <p className="truncate text-[13px] tabular text-muted">
                  {fmtCoords(fix.lat, fix.lng, 4)}
                  {fix.accuracy ? ` · ±${fmtDistance(fix.accuracy)}` : manual ? ' · picked on map' : ''}
                </p>
              </div>
              {!locating && (
                <Button size="sm" variant="ghost" icon={RefreshCw} onClick={locate} aria-label="Refresh location">
                  <span className="sr-only sm:not-sr-only">Refresh</span>
                </Button>
              )}
            </div>
          )}

          <Field label="Add a note" hint="Optional — e.g. “Running 10 min late”">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} rows={2} placeholder="What’s up?" />
          </Field>
        </form>
      )}
    </Modal>
  );
}
