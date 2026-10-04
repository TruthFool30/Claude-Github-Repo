import { useState } from 'react';
import { cn } from '../../lib/cn';
import { Lightbox } from '../../ui';
import type { WallPhoto } from './types';

/** Aspect ratio for a single photo from its stored size, clamped so extremes stay tidy. */
function ratioOf(p: WallPhoto) {
  if (!p.width || !p.height) return 4 / 3;
  return Math.min(2, Math.max(0.8, p.width / p.height));
}

/**
 * Social-style photo mosaic: 1 = natural ratio, 2 side by side, 3 = one tall + two, 4 = 2×2,
 * 5+ = 2×2 with a "+N" overlay (or every photo when `showAll`). Click opens the lightbox.
 */
export function PhotoGrid({ photos, caption, className, showAll }: { photos: WallPhoto[]; caption?: string; className?: string; showAll?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!photos.length) return null;
  const n = photos.length;
  const all = showAll && n > 4;
  const shown = all ? photos : photos.slice(0, n > 4 ? 4 : n);
  const extra = n - shown.length;

  const layout = all
    ? 'grid-cols-3'
    : n === 1
      ? 'grid-cols-1'
      : n === 2
        ? 'grid-cols-2 aspect-[2/1]'
        : n === 3
          ? 'grid-cols-2 grid-rows-2 aspect-[4/3]'
          : 'grid-cols-2 grid-rows-2 aspect-square sm:aspect-[4/3]';

  return (
    <>
      <div className={cn('grid gap-1 overflow-hidden', layout, className)}>
        {shown.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setOpen(i)}
            aria-label={`Open photo ${i + 1} of ${n}`}
            style={n === 1 ? { aspectRatio: String(ratioOf(p)) } : undefined}
            className={cn(
              'group relative block overflow-hidden bg-surface-2 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ring',
              n === 1 && 'max-h-[560px] w-full',
              !all && n === 3 && i === 0 && 'row-span-2',
              all && i === 0 && 'col-span-3 aspect-[16/9]',
              all && i > 0 && 'aspect-square',
            )}
          >
            <img
              src={p.url}
              alt=""
              loading="lazy"
              draggable={false}
              width={p.width ?? undefined}
              height={p.height ?? undefined}
              className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
            {extra > 0 && i === shown.length - 1 && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-3xl font-bold text-white backdrop-blur-[1px]">
                +{extra}
              </span>
            )}
          </button>
        ))}
      </div>
      <Lightbox
        images={photos.map((p) => ({ src: p.url, caption }))}
        index={open}
        onClose={() => setOpen(null)}
        onIndexChange={setOpen}
      />
    </>
  );
}
