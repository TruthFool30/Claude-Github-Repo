import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Smile, X } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, plural } from '../../lib/format';
import { Avatar, Button, Modal, Popover, Spinner, resizeImage, toast } from '../../ui';
import { patchPost, placePost, uploadWithProgress } from './api';
import { MentionTextarea } from './MentionTextarea';
import { MAX_PHOTOS, MAX_POST_CHARS, MOODS } from './moods';
import type { WallPost } from './types';

// Drafts are per person and per family (shared devices, several families).
const draftKey = (userId?: number | null, familyId?: number | null) => `hearth-wall-draft:${userId ?? 0}:${familyId ?? 0}`;
const readDraft = (key: string) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { text?: string; mood?: string | null }) : null;
  } catch {
    return null;
  }
};
const writeDraft = (key: string, d: { text: string; mood: string | null } | null) => {
  try {
    if (!d || (!d.text.trim() && !d.mood)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(d));
  } catch {
    /* storage unavailable */
  }
};

interface NewPhoto {
  id: string;
  file: File;
  url: string;
  width: number | null;
  height: number | null;
}

async function dimensions(file: File): Promise<{ width: number | null; height: number | null }> {
  try {
    const bmp = await createImageBitmap(file);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch {
    return { width: null, height: null };
  }
}

export interface ComposerProps {
  open: boolean;
  onClose: () => void;
  /** Edit an existing post instead of creating one. */
  post?: WallPost | null;
  /** Files picked before the composer opened (the "Photo" quick action). */
  initialFiles?: File[] | null;
}

export function Composer({ open, onClose, post, initialFiles }: ComposerProps) {
  const { user, members, familyId } = useAuth();
  const dKey = draftKey(user?.id, familyId);
  const [progress, setProgress] = useState<number | null>(null);
  const qc = useQueryClient();
  const editing = !!post;
  const [text, setText] = useState('');
  const [mood, setMood] = useState<string | null>(null);
  const [kept, setKept] = useState<WallPost['photos']>([]);
  const [added, setAdded] = useState<NewPhoto[]>([]);
  const [processing, setProcessing] = useState(0);
  const [busy, setBusy] = useState(false);
  const [moodOpen, setMoodOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const moodBtn = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Reset state whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (post) {
      setText(post.body);
      setMood(post.mood);
      setKept(post.photos);
    } else {
      const d = readDraft(dKey);
      setText(d?.text ?? '');
      setMood(d?.mood ?? null);
      setKept([]);
    }
    setAdded([]);
    if (initialFiles?.length) void addFiles(initialFiles);
    const t = setTimeout(() => textRef.current?.focus(), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, post?.id]);

  // Persist the draft of a new post.
  useEffect(() => {
    if (open && !editing) writeDraft(dKey, { text, mood });
  }, [open, editing, text, mood, dKey]);

  // Free object URLs.
  useEffect(() => () => added.forEach((p) => URL.revokeObjectURL(p.url)), [added]);

  const total = kept.length + added.length;
  const remaining = MAX_PHOTOS - total - processing;

  async function addFiles(files: File[] | FileList) {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!images.length) {
      if (Array.from(files).length) toast.error('Please choose photos (JPEG, PNG, WebP, GIF or HEIC)');
      return;
    }
    const room = MAX_PHOTOS - (kept.length + added.length) - processing;
    if (room <= 0) {
      toast.warning(`A post can have up to ${MAX_PHOTOS} photos`);
      return;
    }
    const chosen = images.slice(0, room);
    if (images.length > room) toast.warning(`Only the first ${room} photo${room === 1 ? '' : 's'} were added`, { description: `A post can have up to ${MAX_PHOTOS} photos.` });
    setProcessing((n) => n + chosen.length);
    for (const f of chosen) {
      try {
        const file = await resizeImage(f, { maxSize: 2000 });
        const dims = await dimensions(file);
        setAdded((list) => [...list, { id: `${Date.now()}-${Math.random()}`, file, url: URL.createObjectURL(file), ...dims }]);
      } catch {
        toast.error(`Couldn't read ${f.name}`);
      } finally {
        setProcessing((n) => n - 1);
      }
    }
  }

  const removeAdded = (id: string) => setAdded((list) => list.filter((p) => p.id !== id));

  const empty = !text.trim() && total === 0;
  const tooLong = text.length > MAX_POST_CHARS;
  const dirty = editing
    ? text !== post!.body || mood !== post!.mood || kept.length !== post!.photos.length || added.length > 0
    : !empty || !!mood;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (empty || tooLong || busy || processing) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('body', text.trim());
    fd.append('mood', mood ?? '');
    for (const p of added) fd.append('photos', p.file, p.file.name || 'photo.jpg');
    if (added.length) fd.append('photo_meta', JSON.stringify(added.map((p) => ({ width: p.width, height: p.height }))));
    const onProgress = added.length ? (f: number) => setProgress(f) : () => {};
    if (added.length) setProgress(0);
    try {
      if (editing && post) {
        const removed = post.photos.filter((p) => !kept.some((k) => k.id === p.id)).map((p) => p.id);
        if (removed.length) fd.append('remove_photo_ids', JSON.stringify(removed));
        const saved = await uploadWithProgress<WallPost>('PATCH', `/wall/posts/${post.id}`, fd, onProgress);
        patchPost(qc, post.id, () => saved);
        toast.success('Post updated');
      } else {
        const saved = await uploadWithProgress<WallPost>('POST', '/wall/posts', fd, onProgress);
        placePost(qc, saved);
        writeDraft(dKey, null);
        toast.success(saved.photos.length && !saved.body ? 'Photos shared with the family' : 'Posted to the family wall');
      }
      setText('');
      setMood(null);
      setAdded([]);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const moodMeta = mood ? MOODS[mood] : null;
  const count = text.length;

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      title={editing ? 'Edit post' : 'Share with the family'}
      size="md"
      bodyClassName="pt-1"
      footer={
        <div className="flex w-full items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            className="hidden"
            data-focus-skip
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            icon={ImagePlus}
            onClick={() => fileInput.current?.click()}
            disabled={remaining <= 0 || busy}
            aria-label={`Add photos (${total} of ${MAX_PHOTOS})`}
            className="px-3"
          >
            <span className="hidden sm:inline">Photo</span>
          </Button>
          <Button
            ref={moodBtn}
            variant="ghost"
            icon={moodMeta ? <span className="text-base leading-none">{moodMeta.emoji}</span> : Smile}
            onClick={() => setMoodOpen((o) => !o)}
            disabled={busy}
            aria-haspopup="true"
            aria-expanded={moodOpen}
            className="px-3"
          >
            <span className="hidden sm:inline">{moodMeta ? 'Mood' : 'Feeling'}</span>
          </Button>
          <span className={cn('ml-auto hidden text-xs tabular-nums sm:inline', tooLong ? 'font-semibold text-danger' : count > MAX_POST_CHARS - 200 ? 'text-warning-soft-fg' : 'text-subtle')}>
            {count > MAX_POST_CHARS - 500 ? `${count}/${MAX_POST_CHARS}` : <kbd className="font-sans">⌘/Ctrl + Enter</kbd>}
          </span>
          <Button type="submit" form="wall-composer" loading={busy} disabled={empty || tooLong || processing > 0 || (editing && !dirty)} className="ml-auto min-w-24 sm:ml-2">
            {editing ? 'Save' : 'Post'}
          </Button>
        </div>
      }
    >
      <form
        id="wall-composer"
        onSubmit={submit}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
        className={cn('relative rounded-2xl transition-colors', dragging && 'bg-primary-soft/60 ring-2 ring-primary ring-dashed')}
      >
        <div className="flex items-center gap-3">
          <Avatar user={user} size="md" />
          <div className="min-w-0 text-sm">
            <div className="font-semibold text-fg">{user?.name}</div>
            {moodMeta ? (
              <button type="button" onClick={() => setMood(null)} className="group inline-flex items-center gap-1 text-muted hover:text-fg" aria-label={`Feeling ${moodMeta.label}. Remove mood`}>
                is feeling {moodMeta.emoji} <span className="font-medium text-fg">{moodMeta.label}</span>
                <X size={13} className="opacity-60 group-hover:opacity-100" />
              </button>
            ) : (
              <span className="text-subtle">Visible to everyone in the family</span>
            )}
          </div>
        </div>

        <div className="mt-3">
          <MentionTextarea
            ref={textRef}
            value={text}
            onValueChange={setText}
            members={members.filter((m) => m.id !== user?.id)}
            maxHeight={total ? 200 : 320}
            placeholder={`What's new, ${firstName(user?.name) || 'friend'}?`}
            aria-label="Post text"
            aria-invalid={tooLong || undefined}
            className={cn('min-h-[96px] text-[17px] leading-7', total > 0 && 'min-h-[56px]')}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {tooLong && <p className="mt-1 text-xs font-medium text-danger">Posts can be up to {MAX_POST_CHARS.toLocaleString()} characters.</p>}
        </div>

        {(total > 0 || processing > 0) && (
          <div className="mt-3">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {kept.map((p) => (
                <Thumb key={`k${p.id}`} src={p.url} onRemove={() => setKept((l) => l.filter((x) => x.id !== p.id))} disabled={busy} />
              ))}
              {added.map((p) => (
                <Thumb key={p.id} src={p.url} onRemove={() => removeAdded(p.id)} disabled={busy} />
              ))}
              {Array.from({ length: processing }, (_, i) => (
                <div key={`s${i}`} className="flex aspect-square items-center justify-center rounded-xl bg-surface-2 text-primary">
                  <Spinner size={20} />
                </div>
              ))}
              {remaining > 0 && !busy && (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border-strong text-muted transition hover:border-primary hover:bg-primary-soft/50 hover:text-primary"
                  aria-label="Add more photos"
                >
                  <ImagePlus size={20} />
                  <span className="text-[11px] font-semibold">{total}/{MAX_PHOTOS}</span>
                </button>
              )}
            </div>
          </div>
        )}
        {progress !== null && (
          <div className="mt-3" role="progressbar" aria-label="Uploading photos" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="mb-1 flex justify-between text-xs font-medium text-muted">
              <span>{progress < 1 ? `Uploading ${plural(added.length, 'photo')}…` : 'Finishing up…'}</span>
              <span className="tabular-nums">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-primary-solid transition-[width] duration-200" style={{ width: `${Math.max(4, progress * 100)}%` }} />
            </div>
          </div>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl text-sm font-semibold text-primary">
            Drop photos to add them
          </div>
        )}
      </form>

      <Popover open={moodOpen} onClose={() => setMoodOpen(false)} anchorRef={moodBtn} align="start" className="w-[296px] p-2" role="listbox" aria-label="How are you feeling?">
        <p className="px-2 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-subtle">How are you feeling?</p>
        <div className="grid grid-cols-2 gap-0.5">
          {Object.entries(MOODS).map(([key, m], i) => (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={mood === key}
              autoFocus={i === 0}
              onClick={() => {
                setMood(mood === key ? null : key);
                setMoodOpen(false);
                textRef.current?.focus();
              }}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mood === key ? 'bg-primary-soft font-semibold text-primary-soft-fg' : 'text-fg hover:bg-surface-2',
              )}
            >
              <span className="text-lg leading-none">{m.emoji}</span>
              <span className="truncate">{m.label}</span>
            </button>
          ))}
        </div>
      </Popover>
    </Modal>
  );
}

function Thumb({ src, onRemove, disabled }: { src: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-xl bg-surface-2 animate-scale-in">
      <img src={src} alt="" className="size-full object-cover" />
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove photo"
        className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
      >
        <X size={15} />
      </button>
    </div>
  );
}
