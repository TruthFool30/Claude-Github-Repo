import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, ChevronRight, Download, FolderInput, Heart, ImageUp, Info, MessageCircle, MoreHorizontal, Pencil, Send, Trash2, X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDate, fmtRelative, fmtTime, firstName, plural } from '../../lib/format';
import { useMediaQuery } from '../../lib/hooks';
import { useLive } from '../../lib/live';
import { useSuppressNotificationToast } from '../../lib/notifyFilter';
import { Avatar, Button, Menu, Textarea, toast, useConfirm } from '../../ui';
import { useEscape, useFocusTrap, useOverlayStack, useScrollLock } from '../../ui/overlay';
import { keys, usePhotoDetail } from './data';
import { MoveDialog } from './dialogs';
import { MemberStack } from './MemberStack';
import type { Photo, PhotoComment, PhotoDetail } from './types';

export interface PhotoViewerProps {
  photos: Photo[];
  index: number | null;
  onClose: () => void;
  onIndexChange: (i: number) => void;
  /** Album context: enables "Set as cover". */
  album?: { id: number; cover_photo_id: number | null; can_edit: boolean } | null;
  /** Total photos in this list when only some pages are loaded (timeline). */
  total?: number;
  /** Load the next page; called when browsing near/past the last loaded photo. */
  onNeedMore?: () => void;
}

export function PhotoViewer(props: PhotoViewerProps) {
  const { photos, index } = props;
  const open = index !== null && index >= 0 && index < photos.length;
  if (!open) return null;
  return <ViewerInner {...props} index={index} />;
}

function ViewerInner({ photos, index, onClose, onIndexChange, album, total: totalProp, onNeedMore }: PhotoViewerProps & { index: number }) {
  const photo = photos[index];
  const qc = useQueryClient();
  const confirm = useConfirm();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const isTop = useOverlayStack(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState(false); // mobile details sheet
  const [chrome, setChrome] = useState(true); // mobile: tap to hide bars
  const [moveOpen, setMoveOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [burst, setBurst] = useState(0);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const { data: detail } = usePhotoDetail(photo.id);
  const d: Photo & Partial<PhotoDetail> = detail && detail.id === photo.id ? detail : photo;

  useScrollLock(true);
  useFocusTrap(rootRef, true, isTop);

  // You're already looking at this photo: notifications about it (e.g. "mentioned you") shouldn't pop
  // up over the comments. The toast is suppressed; the notification is marked read (still in the bell).
  const aboutThis = (link: string | null | undefined) => !!link && new RegExp(`[?&]photo=${photo.id}(?!\\d)`).test(link);
  useSuppressNotificationToast((n) => aboutThis(n.link));
  useLive<{ id: number; link: string | null }>(
    'notification',
    (e) => {
      if (e.type === 'notification' && e.payload && aboutThis(e.payload.link)) {
        api.post('/notifications/read', { ids: [e.payload.id] }).catch(() => {});
      }
    },
    { invalidate: false },
  );
  useEscape(true, isTop, () => {
    if (editing) setEditing(false);
    else if (panel && !desktop) setPanel(false);
    else onClose();
  });

  // The `index` prop comes from the URL, which updates a render later. Rapid key presses must build
  // on the photo we are navigating TO, not the one still on screen — so remember that target by id
  // until the props catch up (ids stay right even if the list reorders or shrinks meanwhile).
  const count = photos.length;
  const total = Math.max(totalProp ?? count, count);
  const target = useRef<number | null>(null);
  if (target.current !== null && (photos[index]?.id === target.current || !photos.some((p) => p.id === target.current))) {
    target.current = null;
  }
  // Key/click handlers may still be the closures of an earlier render (listeners are re-attached in an
  // effect, after paint), so navigation always reads the latest rendered values from this ref.
  const live = useRef({ photos, index, count, total, onIndexChange, onNeedMore });
  live.current = { photos, index, count, total, onIndexChange, onNeedMore };
  const currentIndex = () => {
    const { photos, index } = live.current;
    if (target.current !== null) {
      const i = photos.findIndex((p) => p.id === target.current);
      if (i >= 0) return i;
    }
    return index;
  };
  // "Next" pressed past the loaded photos: remember the photo it was pressed on and how many steps
  // ahead the user wants to be. "Previous" presses undo those steps first; any navigation within the
  // loaded photos cancels it; when the page arrives we land exactly `steps` after that photo.
  const pendingAfter = useRef<{ id: number; steps: number } | null>(null);
  const hasPrev = index > 0;
  const hasNext = index < total - 1;
  // No wrap-around: the ends of the list are the ends. Past the loaded photos we fetch the next page.
  const go = (delta: number) => {
    const { photos, count, total, onIndexChange, onNeedMore } = live.current;
    const cur = currentIndex();
    const pend = pendingAfter.current && pendingAfter.current.id === photos[cur]?.id ? pendingAfter.current : null;
    const next = cur + (pend?.steps ?? 0) + delta;
    if (next < 0 || next >= total) return;
    setEditing(false);
    if (next >= count) {
      pendingAfter.current = { id: photos[cur].id, steps: next - cur };
      onNeedMore?.();
      return;
    }
    pendingAfter.current = null;
    if (next === cur) return;
    target.current = photos[next].id;
    onIndexChange(next);
  };
  useEffect(() => {
    const pend = pendingAfter.current;
    if (!pend) return;
    const at = photos.findIndex((p) => p.id === pend.id);
    if (at < 0 || at !== currentIndex()) {
      pendingAfter.current = null;
      return;
    }
    if (at + pend.steps < count) {
      pendingAfter.current = null;
      target.current = photos[at + pend.steps].id;
      onIndexChange(at + pend.steps);
    } else {
      onNeedMore?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, photos]);
  // Prefetch the next page before the viewer reaches the end of what's loaded.
  useEffect(() => {
    if (onNeedMore && count < total && index >= count - 3) onNeedMore();
  }, [index, count, total, onNeedMore]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable="true"], [role="menu"]')) return;
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key.toLowerCase() === 'l' && !e.metaKey && !e.ctrlKey) void toggleLike();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Preload neighbours.
  useEffect(() => {
    [1, -1].forEach((dd) => {
      const p = photos[index + dd];
      if (!p) return;
      const img = new Image();
      img.src = p.url;
    });
  }, [index, count, photos]);

  const patchCaches = (fn: (p: Photo) => Photo) => {
    qc.setQueryData<PhotoDetail>(keys.photo(photo.id), (old) => (old ? (fn(old) as PhotoDetail) : old));
  };

  const toggleLike = async (force?: boolean) => {
    const liked = force ?? !d.liked;
    if (liked === d.liked) {
      if (force) setBurst((b) => b + 1);
      return;
    }
    if (liked) setBurst((b) => b + 1);
    const prev = qc.getQueryData<PhotoDetail>(keys.photo(photo.id));
    patchCaches((p) => ({ ...p, liked, like_count: Math.max(0, p.like_count + (liked ? 1 : -1)) }));
    try {
      if (liked) await api.post(`/photos/items/${photo.id}/like`);
      else await api.del(`/photos/items/${photo.id}/like`);
    } catch (err) {
      if (prev) qc.setQueryData(keys.photo(photo.id), prev);
      toast.error(errorMessage(err));
    } finally {
      void qc.invalidateQueries({ queryKey: ['photos'] });
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this photo?',
      message: 'It will be removed for the whole family, along with its likes and comments.',
      confirmLabel: 'Delete photo',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/photos/items/${photo.id}`);
      toast.success('Photo deleted');
      if (count <= 1) onClose();
      else onIndexChange(index < count - 1 ? index + 1 : index - 1);
      await qc.invalidateQueries({ queryKey: ['photos'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const setCover = async () => {
    if (!album) return;
    try {
      await api.patch(`/photos/albums/${album.id}`, { cover_photo_id: photo.id });
      await qc.invalidateQueries({ queryKey: ['photos'] });
      toast.success('Album cover updated');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    start.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    setDrag(Math.abs(dx) > Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: Math.max(0, dy) });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    const dt = Math.max(1, Date.now() - start.current.t);
    start.current = null;
    setDrag({ x: 0, y: 0 });
    if (Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 60 || Math.abs(dx) / dt > 0.5)) {
      go(dx < 0 ? 1 : -1);
    } else if (dy > 110 || (dy > 30 && dy / dt > 0.7)) {
      onClose();
    } else if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        // double tap / double click → like
        if (tapTimer.current) clearTimeout(tapTimer.current);
        lastTap.current = 0;
        void toggleLike(true);
      } else {
        lastTap.current = now;
        if (!desktop) {
          tapTimer.current = setTimeout(() => setChrome((c) => !c), 280);
        }
      }
    }
  };

  const dim = drag.y ? Math.max(0.35, 1 - drag.y / 400) : 1;
  const iconBtn =
    'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/40';
  const navBtn =
    'absolute top-1/2 z-10 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 sm:flex focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/40';

  const menuItems = [
    { label: 'Download', icon: Download, onSelect: () => downloadPhoto(photo) },
    d.can_edit && { label: d.caption ? 'Edit caption' : 'Add caption', icon: Pencil, onSelect: () => { setEditing(true); setPanel(true); } },
    album && album.can_edit && album.cover_photo_id !== photo.id && { label: 'Set as album cover', icon: ImageUp, onSelect: setCover },
    d.can_edit && { label: 'Move to album…', icon: FolderInput, onSelect: () => setMoveOpen(true) },
    d.can_delete && 'divider' as const,
    d.can_delete && { label: 'Delete photo', icon: Trash2, danger: true, onSelect: remove },
  ];

  const showChrome = desktop || chrome;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${index + 1} of ${total}${d.caption ? `: ${d.caption}` : ''}`}
      tabIndex={-1}
      className="fixed inset-0 z-[48] flex animate-fade-in outline-none"
      style={{ backgroundColor: `rgb(8 9 12 / ${dim})` }}
    >
      <span tabIndex={-1} data-autofocus className="sr-only outline-none">Photo viewer. Use arrow keys to browse, L to like.</span>
      {/* Stage */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            'absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent px-2 pb-6 pt-[max(0.5rem,env(safe-area-inset-top))] text-white transition-opacity sm:px-4',
            showChrome ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <div className="flex min-w-0 items-center gap-1">
            <button type="button" onClick={onClose} aria-label="Close photo" className={iconBtn}>
              <X size={22} />
            </button>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[13px] font-semibold tabular backdrop-blur">
              {index + 1} / {total}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <a href={`/api/photos/items/${photo.id}/download`} download aria-label="Download photo" className={cn(iconBtn, 'max-lg:hidden')}>
              <Download size={20} />
            </a>
            {!desktop && (
              <button type="button" onClick={() => setPanel(true)} aria-label="Photo details" className={iconBtn}>
                <Info size={20} />
              </button>
            )}
            <Menu
              label="Photo actions"
              items={menuItems}
              trigger={() => (
                <button type="button" aria-label="Photo actions" className={iconBtn}>
                  <MoreHorizontal size={22} />
                </button>
              )}
            />
          </div>
        </div>

        <div
          className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden sm:px-20"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {hasPrev && (
            <button type="button" aria-label="Previous photo" onClick={() => go(-1)} className={cn(navBtn, 'left-4')}>
              <ChevronLeft size={26} />
            </button>
          )}
          {!loaded[photo.url] && (
            <>
              <img src={photo.thumb_url} alt="" aria-hidden className="pointer-events-none absolute max-h-full max-w-full scale-100 object-contain opacity-70 blur-sm" />
              <div className="absolute size-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </>
          )}
          <img
            key={photo.url}
            src={photo.url}
            alt={d.caption ?? `Photo by ${d.uploader?.name ?? 'family member'}`}
            draggable={false}
            onLoad={() => setLoaded((l) => ({ ...l, [photo.url]: true }))}
            className={cn(
              'pointer-events-none max-h-full max-w-full object-contain',
              !drag.x && !drag.y && 'transition-transform duration-200',
              loaded[photo.url] ? 'animate-fade-in' : 'opacity-0',
            )}
            style={{ transform: `translate(${drag.x}px, ${drag.y}px) scale(${drag.y ? 1 - drag.y / 1500 : 1})` }}
          />
          {burst > 0 && (
            <Heart
              key={burst}
              aria-hidden
              size={110}
              className="pointer-events-none absolute fill-white text-white drop-shadow-[0_6px_24px_rgb(0_0_0/0.35)] [animation:photo-heart_900ms_ease-out_forwards]"
            />
          )}
          {hasNext && (
            <button type="button" aria-label="Next photo" onClick={() => go(1)} className={cn(navBtn, 'right-4')}>
              <ChevronRight size={26} />
            </button>
          )}
        </div>

        {/* Mobile bottom bar */}
        {!desktop && (
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/75 via-black/40 to-transparent px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 text-white transition-opacity',
              showChrome ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            {d.caption && <p className="mb-2 line-clamp-2 text-[15px] font-medium leading-snug">{d.caption}</p>}
            <div className="mb-3 flex items-center gap-2 text-[13px] text-white/75">
              {d.uploader && <Avatar user={d.uploader} size="xs" />}
              <span className="truncate">
                {d.uploader ? firstName(d.uploader.name) : 'Someone'} · {fmtDate(d.taken_at)}
                {d.album_title ? ` · ${d.album_title}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleLike()}
                aria-pressed={d.liked}
                aria-label={d.liked ? 'Unlike photo' : 'Like photo'}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-white/12 px-4 text-sm font-semibold backdrop-blur transition active:scale-95"
              >
                <Heart size={19} className={cn('transition', d.liked && 'fill-[#ff5a7a] text-[#ff5a7a]')} />
                <span className="tabular">{d.like_count}</span>
              </button>
              <button
                type="button"
                onClick={() => setPanel(true)}
                aria-label={`Comments (${d.comment_count})`}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-white/12 px-4 text-sm font-semibold backdrop-blur transition active:scale-95"
              >
                <MessageCircle size={19} />
                <span className="tabular">{d.comment_count}</span>
              </button>
              <a
                href={`/api/photos/items/${photo.id}/download`}
                download
                aria-label="Download photo"
                className="ml-auto inline-flex size-10 items-center justify-center rounded-full bg-white/12 backdrop-blur"
              >
                <Download size={19} />
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Details panel: side column on desktop, bottom sheet on mobile */}
      {desktop ? (
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-white/5 bg-surface text-fg" aria-label="Photo details">
          <DetailsPanel photo={d} editing={editing} setEditing={setEditing} onLike={toggleLike} />
        </aside>
      ) : (
        panel && (
          <div className="absolute inset-0 z-30 flex flex-col justify-end" role="presentation">
            <button type="button" aria-label="Close details" className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => { setPanel(false); setEditing(false); }} />
            <div className="relative flex max-h-[78dvh] min-h-[50dvh] animate-sheet-in flex-col rounded-t-3xl bg-surface text-fg shadow-pop" aria-label="Photo details" role="region">
              <div className="flex justify-center pb-1 pt-2.5" aria-hidden>
                <span className="h-1.5 w-10 rounded-full bg-border-strong" />
              </div>
              <DetailsPanel photo={d} editing={editing} setEditing={setEditing} onLike={toggleLike} onClose={() => { setPanel(false); setEditing(false); }} />
            </div>
          </div>
        )
      )}

      <MoveDialog open={moveOpen} onClose={() => setMoveOpen(false)} photoIds={[photo.id]} currentAlbumId={photo.album_id} />
      <style>{`@keyframes photo-heart { 0% { transform: scale(.3); opacity: 0 } 18% { transform: scale(1.12); opacity: .95 } 35% { transform: scale(.95) } 70% { opacity: .95 } 100% { transform: scale(1.1) translateY(-30px); opacity: 0 } }`}</style>
    </div>,
    document.body,
  );
}

export function downloadPhoto(photo: Pick<Photo, 'id'>) {
  const a = document.createElement('a');
  a.href = `/api/photos/items/${photo.id}/download`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function DetailsPanel({
  photo, editing, setEditing, onLike, onClose,
}: {
  photo: Photo & Partial<PhotoDetail>;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onLike: () => void;
  onClose?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(photo.comments?.length ?? 0);
  useEffect(() => {
    const n = photo.comments?.length ?? 0;
    if (n > lastCount.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    lastCount.current = n;
  }, [photo.comments?.length]);

  const likers = photo.likers ?? [];
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        {photo.uploader ? <Avatar user={photo.uploader} size="md" /> : <span className="size-9 rounded-full bg-surface-3" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{photo.uploader?.name ?? 'Former member'}</p>
          <p className="truncate text-[13px] text-muted">
            {fmtDate(photo.taken_at, 'EEE, MMM d, yyyy')} · {fmtTime(photo.taken_at)}
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close details" className="inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2">
            <X size={18} />
          </button>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="px-5 py-4">
          {editing ? (
            <CaptionEditor photo={photo} onDone={() => setEditing(false)} />
          ) : photo.caption ? (
            <div className="group flex items-start gap-2">
              <p className="flex-1 whitespace-pre-wrap text-[15px] leading-relaxed">{photo.caption}</p>
              {photo.can_edit && (
                <button type="button" onClick={() => setEditing(true)} aria-label="Edit caption" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-subtle transition hover:bg-surface-2 hover:text-fg">
                  <Pencil size={15} />
                </button>
              )}
            </div>
          ) : photo.can_edit ? (
            <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              <Pencil size={14} /> Add a caption
            </button>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
            {photo.album_title && <span className="rounded-full bg-surface-2 px-2.5 py-0.5 font-medium text-fg">{photo.album_title}</span>}
            {photo.width && photo.height && <span>{photo.width} × {photo.height}</span>}
            <span>Added {fmtRelative(photo.created_at)}</span>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={onLike}
              aria-pressed={photo.liked}
              aria-label={photo.liked ? 'Unlike photo' : 'Like photo'}
              className={cn(
                'inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition active:scale-95',
                photo.liked ? 'border-transparent bg-[#ffe4ea] text-[#c0264b] dark:bg-[#3d1a24] dark:text-[#ff8fa6]' : 'border-border hover:bg-surface-2',
              )}
            >
              <Heart size={18} className={cn('transition-transform', photo.liked && 'scale-110 fill-current')} />
              {photo.liked ? 'Liked' : 'Like'}
            </button>
            {likers.length > 0 && (
              <div className="flex min-w-0 items-center gap-2">
                <MemberStack users={likers} max={4} size={24} />
                <span className="truncate text-[13px] text-muted">{likersText(likers)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-border px-5 pb-4 pt-4">
          <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-subtle">
            {photo.comment_count ? plural(photo.comment_count, 'comment') : 'Comments'}
          </h3>
          {photo.comments === undefined ? (
            <div className="space-y-3" aria-hidden>
              {[0, 1].map((i) => (
                <div key={i} className="flex gap-2.5">
                  <span className="size-7 animate-pulse rounded-full bg-surface-3" />
                  <span className="h-12 flex-1 animate-pulse rounded-2xl bg-surface-2" />
                </div>
              ))}
            </div>
          ) : photo.comments.length === 0 ? (
            <p className="rounded-2xl bg-surface-2 px-4 py-5 text-center text-sm text-muted">No comments yet — say something nice!</p>
          ) : (
            <ul className="space-y-3">
              {photo.comments.map((c) => <CommentRow key={c.id} comment={c} photoId={photo.id} />)}
            </ul>
          )}
        </div>
      </div>
      <CommentComposer photoId={photo.id} />
    </>
  );
}

function likersText(likers: Array<{ id: number; name: string }>) {
  const names = likers.map((l) => firstName(l.name));
  if (names.length === 1) return `${names[0]} likes this`;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${plural(names.length - 2, 'other')}`;
}

function CaptionEditor({ photo, onDone }: { photo: Photo; onDone: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(photo.caption ?? '');
  const [saving, setSaving] = useState(false);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/photos/items/${photo.id}`, { caption: value.trim() || null });
      await qc.invalidateQueries({ queryKey: ['photos'] });
      toast.success('Caption saved');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <Textarea
        aria-label="Caption"
        value={value}
        maxLength={500}
        autoGrow
        rows={2}
        autoFocus
        placeholder="Write a caption…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone} disabled={saving}>Cancel</Button>
        <Button size="sm" type="submit" loading={saving}>Save</Button>
      </div>
    </form>
  );
}

function renderMentions(text: string, names: string[]): ReactNode[] {
  if (!names.length) return [text];
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))(?![\\w])`, 'gi');
  return text.split(re).map((part, i) => (i % 2 === 1 ? <strong key={i} className="font-semibold text-primary">{part}</strong> : part));
}

function CommentRow({ comment, photoId }: { comment: PhotoComment; photoId: number }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { members } = useAuth();
  const names = members.flatMap((m) => [m.name, firstName(m.name)]);
  const remove = async () => {
    if (!(await confirm({ title: 'Delete comment?', message: 'This can’t be undone.', confirmLabel: 'Delete', danger: true }))) return;
    qc.setQueryData<PhotoDetail>(keys.photo(photoId), (old) =>
      old ? { ...old, comments: old.comments.filter((c) => c.id !== comment.id), comment_count: old.comment_count - 1 } : old,
    );
    try {
      await api.del(`/photos/items/${photoId}/comments/${comment.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void qc.invalidateQueries({ queryKey: ['photos'] });
    }
  };
  return (
    <li className="group flex gap-2.5 animate-fade-in">
      {comment.user ? <Avatar user={comment.user} size="sm" /> : <span className="size-7 rounded-full bg-surface-3" />}
      <div className="min-w-0 flex-1">
        <div className={cn('inline-block max-w-full rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2', comment.id < 0 && 'opacity-60')}>
          <p className="text-[13px] font-semibold">{comment.user?.name ?? 'Former member'}</p>
          <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">{renderMentions(comment.body, names)}</p>
        </div>
        <div className="mt-0.5 flex items-center gap-2 pl-2 text-[12px] text-subtle">
          <time dateTime={comment.created_at}>{fmtRelative(comment.created_at)}</time>
          {comment.can_delete && comment.id > 0 && (
            <button type="button" onClick={remove} className="font-medium hover:text-danger focus-visible:text-danger" aria-label="Delete comment">
              Delete
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function CommentComposer({ photoId }: { photoId: number }) {
  const qc = useQueryClient();
  const { user, members } = useAuth();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mention = /(^|\s)@(\w*)$/.exec(value);
  const suggestions = mention ? members.filter((m) => m.id !== user?.id && firstName(m.name).toLowerCase().startsWith(mention[2].toLowerCase())).slice(0, 4) : [];

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = value.trim();
    if (!body || sending || !user) return;
    setSending(true);
    const temp: PhotoComment = { id: -Date.now(), photo_id: photoId, body, created_at: new Date().toISOString(), user_id: user.id, user, can_delete: true };
    qc.setQueryData<PhotoDetail>(keys.photo(photoId), (old) => (old ? { ...old, comments: [...old.comments, temp], comment_count: old.comment_count + 1 } : old));
    setValue('');
    try {
      await api.post(`/photos/items/${photoId}/comments`, { body });
    } catch (err) {
      setValue(body);
      qc.setQueryData<PhotoDetail>(keys.photo(photoId), (old) =>
        old ? { ...old, comments: old.comments.filter((c) => c.id !== temp.id), comment_count: old.comment_count - 1 } : old,
      );
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
      void qc.invalidateQueries({ queryKey: ['photos'] });
      inputRef.current?.focus();
    }
  };

  return (
    <form onSubmit={send} className="relative flex items-end gap-2 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-1 overflow-hidden rounded-xl border border-border bg-surface shadow-pop" role="listbox" aria-label="Mention someone">
          {suggestions.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setValue(value.replace(/@(\w*)$/, `@${firstName(m.name)} `));
                inputRef.current?.focus();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
            >
              <Avatar user={m} size="xs" /> {m.name}
            </button>
          ))}
        </div>
      )}
      {user && <Avatar user={user} size="sm" className="mb-1.5 max-sm:hidden" />}
      <Textarea
        ref={inputRef}
        aria-label="Write a comment"
        placeholder="Add a comment…  (@ to mention)"
        value={value}
        rows={1}
        autoGrow
        maxLength={1000}
        className="max-h-32 min-h-10 flex-1 py-2"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button
        type="submit"
        disabled={!value.trim() || sending}
        aria-label="Send comment"
        className="mb-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-solid text-white transition hover:bg-primary-solid-hover disabled:opacity-40"
      >
        <Send size={16} />
      </button>
    </form>
  );
}
