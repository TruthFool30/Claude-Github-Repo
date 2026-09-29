import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { useEscape, useFocusTrap, useOverlayStack, usePresence, useScrollLock } from './overlay';

export interface LightboxImage {
  src: string;
  alt?: string;
  caption?: ReactNode;
}

export interface LightboxProps {
  images: Array<string | LightboxImage>;
  /** Index of the open image, or null when closed. */
  index: number | null;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  /** Extra toolbar buttons for the current image (e.g. delete, set as cover). */
  actions?: (image: LightboxImage, index: number) => ReactNode;
  /** Show a download button (default true). */
  download?: boolean;
}

const norm = (img: string | LightboxImage): LightboxImage => (typeof img === 'string' ? { src: img } : img);

/**
 * Full-screen image viewer: ←/→ keys, on-screen arrows, swipe left/right, swipe down or Esc to close.
 *   const [open, setOpen] = useState<number | null>(null);
 *   <Lightbox images={photos.map(p => ({ src: p.url, caption: p.caption }))} index={open} onClose={() => setOpen(null)} onIndexChange={setOpen} />
 */
export function Lightbox({ images, index, onClose, onIndexChange, actions, download = true }: LightboxProps) {
  const open = index !== null && index >= 0 && index < images.length;
  const { mounted, closing } = usePresence(open, 200);
  const isTop = useOverlayStack(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const [lastIndex, setLastIndex] = useState(index ?? 0);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});

  if (open && index !== lastIndex) setLastIndex(index);
  const i = open ? index : lastIndex;
  const count = images.length;
  const current = count ? norm(images[Math.min(i, count - 1)]) : null;

  useScrollLock(open);
  useFocusTrap(rootRef, open, isTop);
  useEscape(open, isTop, onClose);

  const go = (delta: number) => {
    if (!count || index === null) return;
    onIndexChange((index + delta + count) % count);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Preload neighbours.
  useEffect(() => {
    if (!open || count < 2) return;
    [1, -1].forEach((d) => {
      const img = new Image();
      img.src = norm(images[(index! + d + count) % count]).src;
    });
  }, [open, index, count, images]);

  if (!mounted || !current) return null;

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
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx < -60 || dx / dt < -0.5) go(1);
      else if (dx > 60 || dx / dt > 0.5) go(-1);
    } else if (dy > 110 || dy / dt > 0.7) {
      onClose();
    } else if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && e.target === e.currentTarget) {
      onClose(); // tap on the backdrop
    }
  };

  const dim = drag.y ? Math.max(0.3, 1 - drag.y / 400) : 1;
  const navBtn =
    'absolute top-1/2 z-10 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 sm:flex focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/40';

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      className={cn('fixed inset-0 z-[80] flex select-none flex-col outline-none', closing ? 'animate-fade-out' : 'animate-fade-in')}
      style={{ backgroundColor: `rgb(0 0 0 / ${0.94 * dim})` }}
    >
      <div className="relative z-10 flex items-center justify-between gap-2 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white sm:px-5">
        <span className="rounded-full bg-white/10 px-3 py-1 text-[13px] font-semibold tabular backdrop-blur">
          {i + 1} / {count}
        </span>
        <div className="flex items-center gap-1">
          {actions?.(current, i)}
          {download && (
            <a
              href={current.src}
              download
              aria-label="Download"
              className="inline-flex size-10 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15"
            >
              <Download size={20} />
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-autofocus
            className="inline-flex size-10 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/40"
          >
            <X size={22} />
          </button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-0 sm:px-20"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {count > 1 && (
          <button type="button" aria-label="Previous image" onClick={() => go(-1)} className={cn(navBtn, 'left-4')}>
            <ChevronLeft size={26} />
          </button>
        )}
        {!loaded[current.src] && <div className="absolute size-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />}
        <img
          key={current.src}
          src={current.src}
          alt={current.alt ?? ''}
          draggable={false}
          onLoad={() => setLoaded((l) => ({ ...l, [current.src]: true }))}
          className={cn('pointer-events-none max-h-full max-w-full object-contain', !drag.x && !drag.y && 'transition-transform duration-200', loaded[current.src] ? 'animate-fade-in' : 'opacity-0')}
          style={{ transform: `translate(${drag.x}px, ${drag.y}px) scale(${drag.y ? 1 - drag.y / 1500 : 1})` }}
        />
        {count > 1 && (
          <button type="button" aria-label="Next image" onClick={() => go(1)} className={cn(navBtn, 'right-4')}>
            <ChevronRight size={26} />
          </button>
        )}
      </div>

      <div className="relative z-10 min-h-14 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-center text-sm text-white/90">
        {current.caption}
      </div>
    </div>,
    document.body,
  );
}
