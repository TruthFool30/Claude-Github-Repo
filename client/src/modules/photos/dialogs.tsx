import { useEffect, useState, type FormEvent } from 'react';
import { Check, FolderPlus, ImageOff, Images } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { Button, Field, Input, Modal, Textarea, toast } from '../../ui';
import { useAlbums } from './data';
import type { Album } from './types';
import mod from './index';

// ---- create / edit album -------------------------------------------------------------------------
export function AlbumFormModal({
  open, onClose, album, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  album?: Album | null;
  onSaved?: (album: Album) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(album?.title ?? '');
    setDescription(album?.description ?? '');
    setDate(album?.event_date ?? '');
    setError(null);
  }, [open, album]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Give your album a name');
      return;
    }
    setSaving(true);
    try {
      const body = { title: title.trim(), description: description.trim() || null, event_date: date || null };
      const saved = album ? await api.patch<Album>(`/photos/albums/${album.id}`, body) : await api.post<Album>('/photos/albums', body);
      await qc.invalidateQueries({ queryKey: ['photos'] });
      toast.success(album ? 'Album updated' : `“${saved.title}” created`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={album ? 'Edit album' : 'New album'}
      description={album ? undefined : 'Collect the photos from a trip, a party or everyday moments.'}
      icon={<span className="flex size-9 items-center justify-center rounded-xl" style={{ backgroundColor: `color-mix(in oklab, ${mod.accent} 14%, transparent)`, color: mod.accent }}><Images size={18} /></span>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="photo-album-form" loading={saving}>{album ? 'Save changes' : 'Create album'}</Button>
        </>
      }
    >
      <form id="photo-album-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Album name" required error={error ?? undefined}>
          <Input
            name="title"
            value={title}
            maxLength={80}
            placeholder="e.g. Summer at the lake"
            onChange={(e) => {
              setTitle(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Description" hint="Optional">
          <Textarea name="description" value={description} maxLength={500} rows={2} autoGrow placeholder="What's this album about?" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Date" hint="Optional — when did it happen?">
          <Input name="event_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

// ---- move photos to an album ---------------------------------------------------------------------
export function MoveDialog({
  open, onClose, photoIds, currentAlbumId, onMoved,
}: {
  open: boolean;
  onClose: () => void;
  photoIds: number[];
  currentAlbumId?: number | null;
  onMoved?: (albumId: number | null) => void;
}) {
  const qc = useQueryClient();
  const { data: albums, isLoading } = useAlbums();
  const [target, setTarget] = useState<number | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) setTarget(undefined);
  }, [open]);

  const move = async (albumId: number | null) => {
    setSaving(true);
    try {
      await api.post('/photos/items/move', { ids: photoIds, album_id: albumId });
      await qc.invalidateQueries({ queryKey: ['photos'] });
      const name = albumId ? albums?.find((a) => a.id === albumId)?.title ?? 'the album' : 'Unsorted';
      toast.success(`${plural(photoIds.length, 'photo')} moved to ${name}`);
      onMoved?.(albumId);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const options: Array<{ id: number | null; title: string; sub: string; thumb: string | null }> = [
    ...(albums ?? []).map((a) => ({ id: a.id, title: a.title, sub: plural(a.photo_count, 'photo'), thumb: a.cover?.thumb_url ?? null })),
    { id: null, title: 'No album', sub: 'Keep in All photos only', thumb: null },
  ];

  return (
    <>
      <Modal
        open={open && !creating}
        onClose={onClose}
        dismissible={!saving}
        title={`Move ${plural(photoIds.length, 'photo')}`}
        description="Choose where these photos should live."
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={() => target !== undefined && move(target)} disabled={target === undefined} loading={saving}>Move</Button>
          </>
        }
      >
        <div role="radiogroup" aria-label="Destination album" className="-mx-1 flex max-h-[46vh] flex-col gap-1 overflow-y-auto px-1 py-1">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-3 rounded-xl p-2 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
          >
            <span className="flex size-12 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border-strong text-primary"><FolderPlus size={20} /></span>
            <span className="text-sm font-semibold text-primary">New album…</span>
          </button>
          {isLoading && <div className="p-4 text-sm text-muted">Loading albums…</div>}
          {options.map((o) => {
            const current = (o.id ?? null) === (currentAlbumId ?? null) && currentAlbumId !== undefined;
            const active = target === o.id;
            return (
              <button
                key={o.id ?? 'none'}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={current}
                onClick={() => setTarget(o.id)}
                onDoubleClick={() => !current && move(o.id)}
                className={cn(
                  'flex items-center gap-3 rounded-xl p-2 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                  active ? 'bg-primary-soft' : 'hover:bg-surface-2',
                  current && 'cursor-not-allowed opacity-50',
                )}
              >
                <span className="size-12 shrink-0 overflow-hidden rounded-lg bg-surface-3">
                  {o.thumb ? <img src={o.thumb} alt="" className="size-full object-cover" /> : (
                    <span className="flex size-full items-center justify-center text-subtle"><ImageOff size={18} /></span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-fg">{o.title}</span>
                  <span className="block text-xs text-muted">{current ? 'Current album' : o.sub}</span>
                </span>
                {active && <Check size={18} className="text-primary" />}
              </button>
            );
          })}
        </div>
      </Modal>
      <AlbumFormModal
        open={open && creating}
        onClose={() => setCreating(false)}
        onSaved={(a) => {
          setCreating(false);
          void move(a.id);
        }}
      />
    </>
  );
}
