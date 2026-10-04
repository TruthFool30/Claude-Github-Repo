import { useEffect, useState, type FormEvent } from 'react';
import { Bell, Crosshair, LocateFixed, MapPinPlus, Save } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button, ColorPicker, Field, Input, Modal, Switch, toast } from '../../ui';
import { getPosition, usePlaceMutations, type PlaceInput } from './data';
import { fmtCoords, fmtDistance } from './geo';
import { LocatorMap, knownTileStatus, type TileStatus } from './LocatorMap';
import { PLACE_ICONS, placeIconMeta } from './placeIcons';
import type { LatLng, LocMember, Place, PlaceIconKey } from './types';

export interface PlaceDialogProps {
  open: boolean;
  onClose: () => void;
  /** Editing an existing place, or null for a new one. */
  place: Place | null;
  /** Starting point for a new place (map click / my location). */
  initial?: LatLng | null;
  places: Place[];
  members: LocMember[];
  onSaved?: (place: Place) => void;
  now: number;
}

const RADII = [50, 100, 150, 250, 500, 1000];

export function PlaceDialog({ open, onClose, place, initial, places, members, onSaved, now }: PlaceDialogProps) {
  const { create, update } = usePlaceMutations();
  const blank = (): PlaceInput & { latText: string; lngText: string } => {
    const start = place ?? initial ?? null;
    return {
      name: place?.name ?? '',
      icon: place?.icon ?? 'home',
      color: place?.color ?? placeIconMeta('home').color,
      lat: start?.lat ?? NaN,
      lng: start?.lng ?? NaN,
      radius: place?.radius ?? 150,
      notify: place?.notify ?? true,
      address: place?.address ?? '',
      latText: start ? String(start.lat.toFixed(6)) : '',
      lngText: start ? String(start.lng.toFixed(6)) : '',
    };
  };
  const [form, setForm] = useState(blank);
  const [colorTouched, setColorTouched] = useState(!!place);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [tiles, setTiles] = useState<TileStatus>(knownTileStatus);
  const [focusKey, setFocusKey] = useState(0);

  useEffect(() => {
    if (open) {
      setForm(blank());
      setColorTouched(!!place);
      setError(null);
      setFocusKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place?.id, initial?.lat, initial?.lng]);

  const hasPoint = Number.isFinite(form.lat) && Number.isFinite(form.lng);
  const setPoint = (p: LatLng, refocus = false) => {
    setForm((f) => ({ ...f, lat: p.lat, lng: p.lng, latText: p.lat.toFixed(6), lngText: p.lng.toFixed(6) }));
    if (refocus) setFocusKey((k) => k + 1);
  };

  const useMyLocation = async () => {
    setLocating(true);
    try {
      const fix = await getPosition();
      setPoint(fix, true);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLocating(false);
    }
  };

  const pickIcon = (icon: PlaceIconKey) => {
    setForm((f) => ({ ...f, icon, color: colorTouched ? f.color : placeIconMeta(icon).color, name: f.name || (icon === 'pin' ? '' : placeIconMeta(icon).label) }));
  };

  const saving = create.isPending || update.isPending;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) return setError('Give the place a name.');
    if (!hasPoint) return setError('Choose where the place is — tap the map or use your location.');
    const body: PlaceInput = {
      name: form.name.trim(), icon: form.icon, color: form.color, lat: form.lat, lng: form.lng, radius: form.radius,
      notify: form.notify, address: form.address?.trim() || null,
    };
    try {
      const saved = place ? await update.mutateAsync({ id: place.id, ...body }) : await create.mutateAsync(body);
      toast.success(place ? `${saved.name} updated` : `${saved.name} added`, {
        description: place ? undefined : form.notify ? 'The family will hear when someone arrives or leaves.' : undefined,
      });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const others = places.filter((p) => p.id !== place?.id);
  const draft = hasPoint ? { lat: form.lat, lng: form.lng, radius: form.radius, color: form.color } : null;
  const insideNow = hasPoint
    ? members.filter((m) => m.location && Math.hypot((m.location.lat - form.lat) * 111320, (m.location.lng - form.lng) * 111320 * Math.cos((form.lat * Math.PI) / 180)) <= form.radius)
    : [];

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      size="lg"
      title={place ? `Edit ${place.name}` : 'New place'}
      description={place ? undefined : 'Saved places show up on the map. Arrivals and departures are shared with the family.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="place-form" loading={saving} icon={place ? Save : MapPinPlus}>
            {place ? 'Save changes' : 'Add place'}
          </Button>
        </>
      }
    >
      <form id="place-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <div>
          <div className="relative isolate h-56 overflow-hidden rounded-2xl border border-border sm:h-64">
            {open && (
              <LocatorMap
                members={[]}
                places={others}
                draft={draft}
                focus={{ key: `f${focusKey}`, points: hasPoint ? [{ lat: form.lat, lng: form.lng }] : places.length ? places.map((p) => ({ lat: p.lat, lng: p.lng })) : [{ lat: 30.2896, lng: -97.7531 }], zoom: hasPoint ? 15 : 13 }}
                picking
                onMapClick={(p) => setPoint(p)}
                tileStatus={tiles}
                onTileStatus={setTiles}
                now={now}
                ariaLabel="Tap to choose where the place is"
              />
            )}
            <div className="pointer-events-none absolute inset-x-3 bottom-3 z-[500] flex justify-center">
              <span className="rounded-full bg-surface/95 px-3 py-1.5 text-[12px] font-semibold text-fg shadow-lift ring-1 ring-border backdrop-blur">
                <Crosshair size={13} className="-mt-0.5 mr-1 inline" />
                {hasPoint ? 'Tap the map to move the pin' : 'Tap the map to drop a pin'}
              </span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] tabular text-muted" data-testid="place-coords">
              {hasPoint ? fmtCoords(form.lat, form.lng) : 'No spot chosen yet'}
              {tiles === 'failed' && <span className="ml-1 text-subtle">· street map offline</span>}
            </span>
            <Button type="button" size="sm" variant="soft" icon={LocateFixed} loading={locating} onClick={useMyLocation}>
              Use my location
            </Button>
          </div>
        </div>

        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. School, Grandma’s, Soccer field" maxLength={60} autoFocus={!!place} />
        </Field>

        <Field label="Icon">
          <div role="radiogroup" aria-label="Icon" className="grid grid-cols-6 gap-2">
            {PLACE_ICONS.map((p) => {
              const on = form.icon === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={p.label}
                  title={p.label}
                  onClick={() => pickIcon(p.key)}
                  className={cn(
                    'flex h-12 items-center justify-center rounded-xl border transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                    on ? 'border-transparent shadow-card' : 'border-border text-muted hover:border-border-strong hover:text-fg',
                  )}
                  style={on ? { backgroundColor: `color-mix(in oklab, ${form.color} 16%, transparent)`, color: form.color, boxShadow: `inset 0 0 0 2px ${form.color}` } : undefined}
                >
                  <p.icon size={20} />
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Color">
          <ColorPicker size="sm" value={form.color} onChange={(color) => { setColorTouched(true); setForm({ ...form, color }); }} />
        </Field>

        <Field
          label="Radius"
          aside={<span className="text-[13px] font-semibold tabular text-fg">{fmtDistance(form.radius)}</span>}
          hint={insideNow.length ? `${insideNow.map((m) => m.name.split(' ')[0]).join(', ')} ${insideNow.length === 1 ? 'is' : 'are'} inside this area right now.` : 'Someone counts as “at” the place inside this circle.'}
        >
          <input
            type="range"
            min={25}
            max={1000}
            step={5}
            value={Math.min(form.radius, 1000)}
            onChange={(e) => setForm({ ...form, radius: Number(e.target.value) })}
            className="w-full"
            style={{ accentColor: form.color }}
            aria-valuetext={fmtDistance(form.radius)}
          />
        </Field>
        <div className="-mt-3 flex flex-wrap gap-1.5">
          {RADII.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setForm({ ...form, radius: r })}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-semibold transition',
                form.radius === r ? 'bg-primary-soft text-primary-soft-fg' : 'bg-surface-2 text-muted hover:text-fg',
              )}
            >
              {fmtDistance(r)}
            </button>
          ))}
        </div>

        <Field label="Address or note" hint="Optional — helps everyone recognize the place.">
          <Input value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="e.g. 710 W Cesar Chavez St" maxLength={200} />
        </Field>

        <details className="group rounded-2xl border border-border px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-fg">Enter coordinates manually</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Latitude">
              <Input
                inputMode="decimal"
                value={form.latText}
                onChange={(e) => {
                  const v = e.target.value;
                  const n = Number(v);
                  setForm((f) => ({ ...f, latText: v, lat: v.trim() && Number.isFinite(n) && Math.abs(n) <= 90 ? n : NaN }));
                }}
                onBlur={() => setFocusKey((k) => k + 1)}
                placeholder="30.30052"
              />
            </Field>
            <Field label="Longitude">
              <Input
                inputMode="decimal"
                value={form.lngText}
                onChange={(e) => {
                  const v = e.target.value;
                  const n = Number(v);
                  setForm((f) => ({ ...f, lngText: v, lng: v.trim() && Number.isFinite(n) && Math.abs(n) <= 180 ? n : NaN }));
                }}
                onBlur={() => setFocusKey((k) => k + 1)}
                placeholder="-97.75611"
              />
            </Field>
          </div>
        </details>

        <div className="rounded-2xl border border-border p-4">
          <Switch
            checked={form.notify}
            onChange={(notify) => setForm({ ...form, notify })}
            label={<span className="inline-flex items-center gap-1.5"><Bell size={15} /> Arrival alerts</span>}
            description="Notify the family when someone arrives at or leaves this place."
          />
        </div>

        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger-soft-fg">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
