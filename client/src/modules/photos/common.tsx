import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, Check, ChevronDown, CloudUpload, FileWarning, FolderInput, FolderPlus, ImageOff, RotateCcw, Trash2, X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { Button, Modal, Spinner, toast, useConfirm } from '../../ui';
import { clearFinished, dismissJob, enqueueUploads, retryJob, useAlbums, usePhotoDetail, useUploads } from './data';
import { AlbumFormModal, MoveDialog } from './dialogs';
import { PhotoViewer } from './PhotoViewer';
import type { Photo } from './types';

// ---- file picker ---------------------------------------------------------------------------------
/** Hidden multi-file input. `pick(albumId)` opens the OS picker; chosen files are queued for that album. */
export function useUploadPicker(defaultAlbumId: number | null = null) {
  const inputRef = useRef<HTMLInputElement>(null);
  const target = useRef<number | null>(defaultAlbumId);
  useEffect(() => {
    target.current = defaultAlbumId;
  }, [defaultAlbumId]);
  const pick = useCallback((albumId: number | null) => {
    target.current = albumId;
    inputRef.current?.click();
  }, []);
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      multiple
      hidden
      data-focus-skip
      data-testid="photo-file-input"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (!files.length) return;
        enqueueUploads(files, target.current); // warns about non-image files itself
      }}
    />
  );
  return { pick, input };
}

// ---- choose where uploads go ----------------------------------------------------------------------
export function UploadTargetDialog({
  open, onClose, files, onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** Files already chosen (drag & drop); when absent, choosing a target opens the file picker via onPick. */
  files?: File[] | null;
  onPick: (albumId: number | null) => void;
}) {
  const { data: albums } = useAlbums();
  const [creating, setCreating] = useState(false);
  const choose = (albumId: number | null) => {
    onClose();
    if (files?.length) {
      enqueueUploads(files, albumId);
    } else onPick(albumId);
  };
  return (
    <>
      <Modal
        open={open && !creating}
        onClose={onClose}
        title={files?.length ? `Add ${plural(files.length, 'photo')} to…` : 'Upload photos to…'}
        description="Pick an album, or keep them in All photos."
        size="sm"
      >
        <div className="-mx-1 flex max-h-[52vh] flex-col gap-1 overflow-y-auto px-1 pb-1">
          <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-3 rounded-xl p-2 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border-strong text-primary"><FolderPlus size={19} /></span>
            <span className="text-sm font-semibold text-primary">New album…</span>
          </button>
          {(albums ?? []).map((a) => (
            <button key={a.id} type="button" onClick={() => choose(a.id)} className="flex items-center gap-3 rounded-xl p-2 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
              <span className="size-11 shrink-0 overflow-hidden rounded-lg bg-surface-3">
                {a.cover ? <img src={a.cover.thumb_url} alt="" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-subtle"><ImageOff size={16} /></span>}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-fg">{a.title}</span>
                <span className="block text-xs text-muted">{plural(a.photo_count, 'photo')}</span>
              </span>
            </button>
          ))}
          <button type="button" onClick={() => choose(null)} className="flex items-center gap-3 rounded-xl p-2 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><CloudUpload size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-fg">No album</span>
              <span className="block text-xs text-muted">Just add to All photos</span>
            </span>
          </button>
        </div>
      </Modal>
      <AlbumFormModal
        open={open && creating}
        onClose={() => setCreating(false)}
        onSaved={(a) => {
          setCreating(false);
          choose(a.id);
        }}
      />
    </>
  );
}

// ---- drag & drop anywhere -------------------------------------------------------------------------
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) cb.current(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return over;
}

export function DropOverlay({ show, label }: { show: boolean; label: ReactNode }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[45] flex items-center justify-center bg-primary/10 p-6 backdrop-blur-[2px] animate-fade-in">
      <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary bg-surface/95 px-10 py-9 text-center shadow-pop animate-scale-in">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary"><CloudUpload size={28} /></span>
        <p className="text-lg font-bold text-fg">{label}</p>
        <p className="text-sm text-muted">Drop to upload — we'll resize them for you</p>
      </div>
    </div>
  );
}

// ---- upload progress tray ---------------------------------------------------------------------------
/** Local preview, or a file icon when the browser can't show it (e.g. a rejected, non-image file). */
function JobThumb({ src, failed }: { src: string; failed: boolean }) {
  const [broken, setBroken] = useState(false);
  if (broken || failed) {
    return (
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', failed ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-subtle')} aria-hidden>
        <FileWarning size={17} />
      </span>
    );
  }
  return <img src={src} alt="" onError={() => setBroken(true)} className="size-9 shrink-0 rounded-md bg-surface-3 object-cover" />;
}

export function UploadTray() {
  const { jobs } = useUploads();
  // Phones: start as a one-line bar over the app's top bar (not over the page header); expand on demand.
  const [collapsed, setCollapsed] = useState(() => !window.matchMedia('(min-width: 1024px)').matches);
  if (!jobs.length) return null;
  const active = jobs.filter((j) => j.status !== 'done' && j.status !== 'error');
  const done = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'error').length;
  const overall = jobs.reduce((s, j) => s + (j.status === 'error' ? 1 : j.progress), 0) / jobs.length;
  const title = active.length
    ? `Uploading ${Math.min(done + 1, jobs.length)} of ${jobs.length}`
    : failed
      ? `${plural(failed, 'upload')} failed`
      : `${plural(done, 'photo')} uploaded`;

  return (
    <section
      aria-label="Photo uploads"
      aria-live="polite"
      className="fixed inset-x-3 top-[calc(4px+env(safe-area-inset-top))] z-[44] mx-auto max-w-sm overflow-hidden rounded-2xl border border-border bg-surface shadow-pop animate-scale-in lg:inset-x-auto lg:right-6 lg:top-20 lg:w-[340px]"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', failed && !active.length ? 'bg-danger-soft text-danger' : active.length ? 'bg-primary-soft text-primary' : 'bg-success-soft text-success-soft-fg')}>
          {active.length ? <Spinner size={16} /> : failed ? <AlertCircle size={17} /> : <Check size={17} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{title}</p>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)} aria-label="Overall upload progress">
            <div className={cn('h-full rounded-full transition-[width] duration-300', failed && !active.length ? 'bg-danger' : 'bg-primary-solid')} style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
        </div>
        <button type="button" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Show uploads' : 'Hide upload list'} aria-expanded={!collapsed} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
          <ChevronDown size={18} className={cn('transition-transform', collapsed && 'rotate-180')} />
        </button>
        {!active.length && (
          <button type="button" onClick={clearFinished} aria-label="Dismiss uploads" className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
            <X size={18} />
          </button>
        )}
      </div>
      {!collapsed && (
        <ul className="max-h-56 overflow-y-auto border-t border-border py-1">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-3 px-4 py-1.5">
              <JobThumb src={j.preview} failed={j.status === 'error'} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-fg">{j.name}</p>
                {j.status === 'error' ? (
                  <p className="line-clamp-2 text-xs leading-snug text-danger">{j.error}</p>
                ) : (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                    <div className={cn('h-full rounded-full transition-[width] duration-200', j.status === 'done' ? 'bg-success' : 'bg-primary-solid')} style={{ width: `${Math.round(j.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {j.status === 'done' && <Check size={16} className="shrink-0 text-success" aria-label="Uploaded" />}
              {j.status === 'error' && (
                <>
                  {j.retryable !== false && (
                    <button type="button" onClick={() => retryJob(j.id)} aria-label={`Retry ${j.name}`} className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"><RotateCcw size={15} /></button>
                  )}
                  <button type="button" onClick={() => dismissJob(j.id)} aria-label={`Dismiss ${j.name}`} className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"><X size={15} /></button>
                </>
              )}
              {(j.status === 'queued' || j.status === 'preparing') && <span className="shrink-0 text-xs text-subtle">{j.status === 'queued' ? 'Waiting' : 'Resizing'}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- multi-select ------------------------------------------------------------------------------------
export function useSelection() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggle = useCallback((id: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const start = useCallback((id?: number) => {
    setSelecting(true);
    setSelected(id ? new Set([id]) : new Set());
  }, []);
  const stop = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"]') && stop();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting, stop]);
  return { selecting, selected, toggle, start, stop, setSelected };
}

export function SelectionBar({
  selection, photos, currentAlbumId,
}: {
  selection: ReturnType<typeof useSelection>;
  photos: Photo[];
  currentAlbumId?: number | null;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!selection.selecting) return null;
  const chosen = photos.filter((p) => selection.selected.has(p.id));
  const n = chosen.length;
  const canMove = n > 0 && chosen.every((p) => p.can_edit);
  const canDelete = n > 0 && chosen.every((p) => p.can_delete);
  const allSelected = n === photos.length && n > 0;

  const del = async () => {
    const ok = await confirm({
      title: `Delete ${plural(n, 'photo')}?`,
      message: 'They will be removed for the whole family, with their likes and comments.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post('/photos/items/delete', { ids: chosen.map((p) => p.id) });
      toast.success(`${plural(n, 'photo')} deleted`);
      selection.stop();
      await qc.invalidateQueries({ queryKey: ['photos'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hint = n && (!canMove || !canDelete) ? 'Some photos belong to others' : null;
  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected photos"
        className="fixed inset-x-3 bottom-[calc(80px+env(safe-area-inset-bottom))] z-[44] mx-auto flex max-w-xl items-center gap-1.5 rounded-2xl border border-border bg-surface p-2 pl-3 shadow-pop animate-scale-in lg:bottom-6"
      >
        <button type="button" onClick={selection.stop} aria-label="Cancel selection" className="inline-flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg">
          <X size={18} />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-sm font-semibold text-fg" aria-live="polite">{n ? `${n} selected` : 'Select photos'}</p>
          {hint ? <p className="truncate text-xs text-muted">{hint}</p> : (
            <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => selection.setSelected(allSelected ? new Set() : new Set(photos.map((p) => p.id)))}>
              {allSelected ? 'Clear' : 'Select all'}
            </button>
          )}
        </div>
        <Button size="sm" variant="secondary" icon={FolderInput} disabled={!canMove || busy} onClick={() => setMoveOpen(true)}>
          <span className="max-sm:sr-only">Move</span>
        </Button>
        <Button size="sm" variant="danger" icon={Trash2} disabled={!canDelete} loading={busy} onClick={del}>
          <span className="max-sm:sr-only">Delete</span>
        </Button>
      </div>
      <MoveDialog open={moveOpen} onClose={() => setMoveOpen(false)} photoIds={chosen.map((p) => p.id)} currentAlbumId={currentAlbumId} onMoved={() => selection.stop()} />
    </>
  );
}

// ---- viewer bound to ?photo= ---------------------------------------------------------------------------
/**
 * Opens the photo viewer for `?photo=<id>` (deep links from the Wall, notifications and search work too).
 * Opening pushes a history entry, so the phone's back button closes the viewer.
 */
export function useViewerParam() {
  const [params, setParams] = useSearchParams();
  const pushed = useRef(false);
  const openId = Number(params.get('photo')) || null;
  const open = useCallback((id: number) => {
    pushed.current = true;
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('photo', String(id));
      return n;
    });
  }, [setParams]);
  const change = useCallback((id: number) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('photo', String(id));
      return n;
    }, { replace: true });
  }, [setParams]);
  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete('photo');
      return n;
    }, { replace: true });
  }, [setParams]);
  return { openId, open, change, close };
}

export function ViewerHost({
  photos, viewer, album, ready, total, onNeedMore,
}: {
  total?: number;
  onNeedMore?: () => void;
  photos: Photo[];
  viewer: ReturnType<typeof useViewerParam>;
  album?: { id: number; cover_photo_id: number | null; can_edit: boolean } | null;
  /** The list has loaded (so a missing id means "not in this list"). */
  ready: boolean;
}) {
  const idx = viewer.openId ? photos.findIndex((p) => p.id === viewer.openId) : -1;
  const standalone = ready && viewer.openId !== null && idx < 0;
  const { data: single, isError } = usePhotoDetail(standalone ? viewer.openId : null);
  useEffect(() => {
    if (standalone && isError) {
      toast.error('That photo is no longer available');
      viewer.close();
    }
  }, [standalone, isError, viewer]);
  if (!viewer.openId) return null;
  if (idx >= 0) {
    return (
      <PhotoViewer photos={photos} index={idx} album={album} total={total} onNeedMore={onNeedMore} onClose={viewer.close} onIndexChange={(i) => photos[i] && viewer.change(photos[i].id)} />
    );
  }
  if (standalone && single) {
    return <PhotoViewer photos={[single]} index={0} album={album} onClose={viewer.close} onIndexChange={() => {}} />;
  }
  return null;
}
