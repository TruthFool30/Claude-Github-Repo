import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownUp, ArrowLeft, CalendarDays, CheckSquare, ImagePlus, Images, MoreHorizontal, Pencil, Trash2, Upload } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { Button, EmptyState, Fab, IconButton, Menu, Modal, Skeleton, toast } from '../../ui';
import { useAlbum } from './data';
import { AlbumFormModal } from './dialogs';
import { DropOverlay, SelectionBar, ViewerHost, useFileDrop, useSelection, useUploadPicker, useViewerParam } from './common';
import { enqueueUploads } from './data';
import { GridSkeleton, JustifiedGrid } from './JustifiedGrid';
import { albumDateLabel } from './Library';
import type { AlbumDetail } from './types';
import { MemberStack } from './MemberStack';
import mod from './index';

export function AlbumPage() {
  const { id } = useParams();
  const albumId = Number(id);
  const navigate = useNavigate();
  const { members } = useAuth();
  const { data: album, isLoading, error, refetch } = useAlbum(albumId);
  const [sortOldest, setSortOldest] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { pick, input } = useUploadPicker(Number.isInteger(albumId) ? albumId : null);
  const viewer = useViewerParam();
  const selection = useSelection();
  const dragging = useFileDrop((files) => {
    enqueueUploads(files, albumId); // warns about non-image files itself
  }, !!album);
  useDocumentTitle(album?.title ?? 'Album');

  const photos = useMemo(() => {
    const list = album?.photos ?? [];
    return sortOldest ? [...list].reverse() : list;
  }, [album, sortOldest]);

  if (isLoading) {
    return (
      <div>
        <Skeleton className="mb-6 h-48 w-full rounded-3xl sm:h-64" />
        <GridSkeleton rows={3} />
      </div>
    );
  }
  if (error || !album) {
    const notFound = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <EmptyState
        icon={Images}
        accent={mod.accent}
        title={notFound ? 'Album not found' : "Couldn't load this album"}
        description={notFound ? 'It may have been deleted, or it belongs to another family.' : errorMessage(error)}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate('/photos')}>All albums</Button>
            {!notFound && <Button onClick={() => refetch()}>Try again</Button>}
          </div>
        }
      />
    );
  }

  const contributors = album.contributor_ids.map((cid) => members.find((m) => m.id === cid)).filter((m): m is NonNullable<typeof m> => !!m);
  const date = albumDateLabel(album);
  const cover = album.cover?.url ?? null;

  return (
    <div className={cn(selection.selecting && 'pb-24')}>
      {input}
      {/* Hero */}
      <section className="relative -mx-4 -mt-5 mb-6 overflow-hidden sm:mx-0 sm:mt-0 sm:rounded-3xl">
        <div className="relative h-56 sm:h-72">
          {cover ? (
            <>
              <img src={cover} alt="" className="absolute inset-0 size-full scale-105 object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-black/20" />
            </>
          ) : (
            <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${mod.accent}, #8E4EC6)` }} />
          )}
          <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3 sm:p-4">
            <button
              type="button"
              onClick={() => navigate('/photos')}
              aria-label="Back to albums"
              className="inline-flex size-10 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur transition hover:bg-black/45 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50"
            >
              <ArrowLeft size={20} />
            </button>
            {(album.can_edit || album.can_delete) && (
              <Menu
                label="Album actions"
                items={[
                  album.can_edit && { label: 'Edit album', icon: Pencil, onSelect: () => setEditOpen(true) },
                  album.photos.length > 0 && { label: 'Select photos', icon: CheckSquare, onSelect: () => selection.start() },
                  album.can_delete && 'divider',
                  album.can_delete && { label: 'Delete album', icon: Trash2, danger: true, onSelect: () => setDeleteOpen(true) },
                ]}
                trigger={() => (
                  <IconButton icon={MoreHorizontal} label="Album actions" className="!size-10 !rounded-full bg-black/30 !text-white backdrop-blur hover:!bg-black/45" />
                )}
              />
            )}
          </div>
          <div className="absolute inset-x-0 bottom-0 p-5 text-white sm:p-7">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight drop-shadow sm:text-[34px]">{album.title}</h1>
            {album.description && <p className="mt-1 line-clamp-2 max-w-2xl text-[15px] text-white/85">{album.description}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-medium text-white/85">
              <span className="inline-flex items-center gap-1.5"><Images size={15} /> {plural(album.photo_count, 'photo')}</span>
              {date && <span className="inline-flex items-center gap-1.5"><CalendarDays size={15} /> {date}</span>}
              {contributors.length > 0 && (
                <span className="inline-flex items-center gap-2">
                  <MemberStack users={contributors} max={4} size={24} ringClass="ring-black/30" />
                  {contributors.length === 1 ? `by ${firstName(contributors[0].name)}` : `${contributors.length} contributors`}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Toolbar */}
      {album.photos.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button icon={Upload} onClick={() => pick(album.id)} className="max-lg:hidden">Add photos</Button>
          {!selection.selecting && (
            <Button variant="secondary" icon={CheckSquare} onClick={() => selection.start()}>
              Select
            </Button>
          )}
          <Button variant="ghost" icon={ArrowDownUp} onClick={() => setSortOldest((s) => !s)} className="ml-auto" aria-label={`Sort: ${sortOldest ? 'oldest first' : 'newest first'}`}>
            {sortOldest ? 'Oldest first' : 'Newest first'}
          </Button>
        </div>
      )}

      {album.photos.length === 0 ? (
        <button
          type="button"
          onClick={() => pick(album.id)}
          className="flex w-full flex-col items-center justify-center rounded-3xl border-2 border-dashed border-border-strong bg-surface px-6 py-14 text-center transition hover:border-primary/60 hover:bg-primary-soft/30 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
        >
          <span className="mb-4 flex size-16 items-center justify-center rounded-2xl" style={{ backgroundColor: `color-mix(in oklab, ${mod.accent} 14%, transparent)`, color: mod.accent }}>
            <ImagePlus size={30} />
          </span>
          <span className="text-lg font-bold text-fg">Add the first photos</span>
          <span className="mt-1 max-w-sm text-[15px] text-muted">Click to choose photos, or drag &amp; drop them anywhere on this page. Everyone in the family can add to this album.</span>
          <span className={cn('mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-primary-solid px-4 text-sm font-semibold text-white')}>
            <Upload size={16} /> Choose photos
          </span>
        </button>
      ) : (
        <JustifiedGrid
          photos={photos}
          onOpen={(i) => viewer.open(photos[i].id)}
          selecting={selection.selecting}
          selected={selection.selected}
          onToggle={selection.toggle}
          onStartSelect={(pid) => selection.start(pid)}
        />
      )}

      {!selection.selecting && <Fab label="Add photos" icon={ImagePlus} accent={mod.accent} onClick={() => pick(album.id)} />}
      <SelectionBar selection={selection} photos={photos} currentAlbumId={album.id} />
      <ViewerHost photos={photos} viewer={viewer} album={album} ready />
      <AlbumFormModal open={editOpen} onClose={() => setEditOpen(false)} album={album} />
      <DeleteAlbumDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} album={album} />
      <DropOverlay show={dragging} label={`Add photos to ${album.title}`} />
    </div>
  );
}

function DeleteAlbumDialog({ open, onClose, album }: { open: boolean; onClose: () => void; album: AlbumDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const n = album.photo_count;
  const { isAdmin } = useAuth();
  const mine = album.photos.filter((p) => p.can_delete).length;
  const others = n - mine;
  const del = async () => {
    setBusy(true);
    try {
      const res = await api.del<{ deleted_photos: number; kept_photos: number }>(`/photos/albums/${album.id}`, { keep_photos: keep });
      toast.success(`“${album.title}” deleted`, {
        description: res.kept_photos ? `${plural(res.kept_photos, 'photo')} kept in All photos` : undefined,
      });
      onClose();
      navigate('/photos', { replace: true });
      await qc.invalidateQueries({ queryKey: ['photos'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const option = (value: boolean, title: string, body: string, disabled = false) => (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition',
        keep === value ? 'border-primary bg-primary-soft/50' : 'border-border hover:bg-surface-2',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input type="radio" name="keep" className="mt-1 accent-[var(--primary)]" checked={keep === value} disabled={disabled} onChange={() => setKeep(value)} />
      <span>
        <span className="block text-sm font-semibold text-fg">{title}</span>
        <span className="block text-[13px] text-muted">{body}</span>
      </span>
    </label>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={`Delete “${album.title}”?`}
      description={n ? undefined : 'This album is empty.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={del} loading={busy}>{n && !keep && mine ? `Delete album and ${plural(mine, 'photo')}` : 'Delete album'}</Button>
        </>
      }
    >
      {n > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">What should happen to the photos?</legend>
          {option(true, 'Keep the photos', `The ${plural(n, 'photo')} stay in All photos.`)}
          {isAdmin || !others
            ? option(false, 'Delete the photos too', 'Photos, likes and comments are removed for everyone.')
            : option(
                false,
                `Delete the ${plural(mine, 'photo')} you added`,
                `${plural(others, 'photo')} from others will stay in All photos.`,
                mine === 0,
              )}
        </fieldset>
      )}
    </Modal>
  );
}
