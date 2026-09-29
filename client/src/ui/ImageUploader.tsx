import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, ImagePlus, Trash2 } from 'lucide-react';
import { cn } from '../lib/cn';
import { toast } from './toast';
import { errorMessage } from '../lib/api';
import { Spinner } from './Spinner';

export interface ResizeOptions {
  /** Longest edge in px (default 2000). */
  maxSize?: number;
  /** JPEG quality 0..1 (default 0.85). */
  quality?: number;
}

/**
 * Downscale an image client-side to at most `maxSize` px on its longest edge and re-encode as JPEG.
 * GIFs / non-images are returned untouched; if re-encoding doesn't help, the original is returned.
 */
export async function resizeImage(file: File, { maxSize = 2000, quality = 0.85 }: ResizeOptions = {}): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      source = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    } catch {
      return file; // e.g. HEIC the browser can't decode — let the server store it as-is
    }
  }
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return file;
  ctx2d.fillStyle = '#fff';
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  ctx2d.imageSmoothingQuality = 'high';
  ctx2d.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ('close' in source) source.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob || (scale === 1 && blob.size >= file.size)) return file;
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}

/** FormData with a single `file` field (+ extra fields) — ready for api.upload(). */
export function fileForm(file: File, fields: Record<string, string | number | null | undefined> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) fd.append(k, String(v));
  fd.append('file', file);
  return fd;
}

export interface ImageUploaderProps extends ResizeOptions {
  /** Current image URL (shown as preview). */
  value?: string | null;
  /** Called with the already-resized file. Return a promise to show a loading state. */
  onSelect: (file: File) => unknown | Promise<unknown>;
  /** Shows a remove button when there is a value. */
  onRemove?: () => unknown | Promise<unknown>;
  /** Allow picking several files (onSelect is called once per file, sequentially). */
  multiple?: boolean;
  /** 'circle' = avatar picker; 'rect' = drop zone / cover (default). */
  shape?: 'rect' | 'circle';
  /** CSS aspect-ratio for rect previews, e.g. '16 / 9' (default '3 / 1' covers). */
  aspect?: string;
  label?: ReactNode;
  hint?: ReactNode;
  /** Circle diameter in px. */
  size?: number;
  disabled?: boolean;
  className?: string;
  /** Custom trigger: any content; clicking it opens the file dialog. */
  children?: ReactNode;
  /** Fallback content inside an empty circle (e.g. <Avatar/>). */
  placeholder?: ReactNode;
}

/**
 * Pick → preview → client-side resize (max 2000px JPEG) → onSelect(file).
 *   <ImageUploader value={family.cover_url} onSelect={(f) => api.upload('/family/cover', fileForm(f))} />
 *   <ImageUploader shape="circle" value={user.avatar_url} onSelect={uploadAvatar} placeholder={<Avatar user={user} size="xl" />} />
 *   <ImageUploader multiple onSelect={uploadPhoto}><Button icon={Upload}>Upload</Button></ImageUploader>
 */
export function ImageUploader({
  value, onSelect, onRemove, multiple, shape = 'rect', aspect = '3 / 1', label, hint, size = 104, disabled,
  className, children, placeholder, maxSize, quality,
}: ImageUploaderProps) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  // Drop the local preview once the server value changes.
  useEffect(() => setPreview(null), [value]);

  const handleFiles = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) {
      if (files && Array.from(files).length) toast.error('Please choose an image file');
      return;
    }
    setBusy(true);
    try {
      const chosen = multiple ? list : list.slice(0, 1);
      setProgress(chosen.length > 1 ? { done: 0, total: chosen.length } : null);
      for (const [i, f] of chosen.entries()) {
        const resized = await resizeImage(f, { maxSize, quality });
        if (!multiple && !children) setPreview(URL.createObjectURL(resized));
        await onSelect(resized);
        if (chosen.length > 1) setProgress({ done: i + 1, total: chosen.length });
      }
    } catch (err) {
      setPreview(null);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  const open = () => !disabled && !busy && input.current?.click();
  const shown = preview ?? value ?? null;
  const fileInput = (
    <input
      ref={input}
      type="file"
      accept="image/*,.heic,.heif"
      multiple={multiple}
      className="hidden"
      onChange={(e) => handleFiles(e.target.files)}
      data-focus-skip
    />
  );
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (!disabled) handleFiles(e.dataTransfer.files);
    },
  };

  if (children) {
    return (
      <span className={cn('relative inline-flex', className)} {...dropProps}>
        {fileInput}
        <span
          onClick={open}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open()}
          className={cn('inline-flex', busy && 'pointer-events-none opacity-70')}
        >
          {children}
        </span>
        {busy && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs font-semibold text-primary">
            <Spinner size={16} />
            {progress && `${progress.done}/${progress.total}`}
          </span>
        )}
      </span>
    );
  }

  if (shape === 'circle') {
    return (
      <div className={cn('flex flex-col items-center gap-2', className)}>
        {fileInput}
        <div className="relative" style={{ width: size, height: size }}>
          <button
            type="button"
            onClick={open}
            disabled={disabled}
            aria-label={shown ? 'Change photo' : 'Upload photo'}
            className="group relative size-full overflow-hidden rounded-full bg-surface-2 ring-4 ring-surface shadow-card focus-visible:outline-none focus-visible:ring-ring"
            {...dropProps}
          >
            {shown ? <img src={shown} alt="" className="size-full object-cover" /> : placeholder ?? <Camera className="m-auto text-subtle" size={28} />}
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
              <Camera size={22} />
            </span>
            {busy && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
                <Spinner size={22} />
              </span>
            )}
          </button>
          <span className="pointer-events-none absolute bottom-0.5 right-0.5 flex size-8 items-center justify-center rounded-full bg-primary text-white ring-[3px] ring-surface">
            <Camera size={15} />
          </span>
        </div>
        {(label || (onRemove && value)) && (
          <div className="flex items-center gap-3 text-sm">
            {label && <span className="font-medium text-fg">{label}</span>}
            {onRemove && value && (
              <button type="button" onClick={() => onRemove()} className="font-medium text-danger hover:underline">
                Remove
              </button>
            )}
          </div>
        )}
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {fileInput}
      {label && <span className="text-[13px] font-semibold text-fg">{label}</span>}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={open}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}
        style={{ aspectRatio: aspect }}
        className={cn(
          'group relative flex w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed transition-all',
          'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
          dragging ? 'border-primary bg-primary-soft' : shown ? 'border-transparent' : 'border-border-strong bg-surface-2 hover:border-primary/60 hover:bg-primary-soft/40',
          disabled && 'pointer-events-none opacity-60',
        )}
        {...dropProps}
      >
        {shown ? (
          <>
            <img src={shown} alt="" className="absolute inset-0 size-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent opacity-0 transition-opacity group-hover:opacity-100" />
            <div className="absolute bottom-3 right-3 flex gap-2 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5 text-xs font-semibold text-white backdrop-blur">
                <ImagePlus size={14} /> Change
              </span>
              {onRemove && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5 text-xs font-semibold text-white backdrop-blur hover:bg-danger"
                >
                  <Trash2 size={14} /> Remove
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-surface text-primary shadow-card">
              <ImagePlus size={20} />
            </span>
            <span className="text-sm font-semibold text-fg">
              {dragging ? 'Drop to upload' : multiple ? 'Add photos' : 'Upload an image'}
            </span>
            <span className="text-xs text-muted">Click or drag & drop</span>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/70 text-primary backdrop-blur-sm">
            <Spinner size={26} />
            {progress && <span className="text-xs font-semibold">{progress.done} / {progress.total}</span>}
          </div>
        )}
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
