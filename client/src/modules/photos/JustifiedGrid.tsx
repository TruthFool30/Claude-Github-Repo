import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Heart, MessageCircle } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/hooks';
import type { Photo } from './types';

const GAP = 6;
const aspectOf = (p: Pick<Photo, 'width' | 'height'>) => {
  const a = p.width && p.height ? p.width / p.height : 4 / 3;
  return Math.min(2.4, Math.max(0.55, a));
};

interface Row {
  height: number;
  items: Array<{ photo: Photo; width: number; index: number }>;
}

/** Google-Photos-style justified rows: every row fills the width, keeping each photo's aspect ratio. */
export function layoutRows(photos: Photo[], containerWidth: number, target: number): Row[] {
  const rows: Row[] = [];
  let current: Array<{ photo: Photo; aspect: number; index: number }> = [];
  let sum = 0;
  photos.forEach((photo, index) => {
    const aspect = aspectOf(photo);
    current.push({ photo, aspect, index });
    sum += aspect;
    const width = sum * target + GAP * (current.length - 1);
    if (width >= containerWidth) {
      const h = (containerWidth - GAP * (current.length - 1)) / sum;
      rows.push({ height: h, items: current.map((c) => ({ photo: c.photo, index: c.index, width: c.aspect * h })) });
      current = [];
      sum = 0;
    }
  });
  if (current.length) {
    const h = Math.min(target, (containerWidth - GAP * (current.length - 1)) / sum);
    rows.push({ height: h, items: current.map((c) => ({ photo: c.photo, index: c.index, width: c.aspect * h })) });
  }
  return rows;
}

export interface JustifiedGridProps {
  photos: Photo[];
  /** Index into `photos`. */
  onOpen: (index: number) => void;
  selecting?: boolean;
  selected?: Set<number>;
  onToggle?: (id: number) => void;
  /** Long-press / right click on a photo starts selection mode. */
  onStartSelect?: (id: number) => void;
  /** Index offset used for the data-index attribute (timeline groups). */
  className?: string;
}

export function JustifiedGrid({ photos, onOpen, selecting, selected, onToggle, onStartSelect, className }: JustifiedGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const wide = useMediaQuery('(min-width: 1024px)');
  const mid = useMediaQuery('(min-width: 640px)');
  const target = wide ? 230 : mid ? 180 : 122;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => (width ? layoutRows(photos, width, target) : []), [photos, width, target]);

  return (
    <div ref={ref} className={cn('flex w-full flex-col', className)} style={{ gap: GAP }} role="list">
      {rows.map((row, ri) => (
        <div key={ri} className="flex" style={{ gap: GAP, height: row.height }}>
          {row.items.map(({ photo, width: w, index }) => (
            <Tile
              key={photo.id}
              photo={photo}
              width={w}
              height={row.height}
              selecting={!!selecting}
              selected={!!selected?.has(photo.id)}
              onOpen={() => onOpen(index)}
              onToggle={() => onToggle?.(photo.id)}
              onStartSelect={onStartSelect ? () => onStartSelect(photo.id) : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Tile({
  photo, width, height, selecting, selected, onOpen, onToggle, onStartSelect,
}: {
  photo: Photo; width: number; height: number; selecting: boolean; selected: boolean;
  onOpen: () => void; onToggle: () => void; onStartSelect?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const press = useRef<{ t: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth) setLoaded(true);
  }, []);

  const label = [photo.caption || 'Photo', photo.uploader ? `by ${photo.uploader.name}` : null].filter(Boolean).join(', ');
  const clear = () => {
    if (press.current) clearTimeout(press.current.t);
  };

  return (
    <div role="listitem" className="relative shrink-0" style={{ width, height }}>
      <button
        type="button"
        aria-label={selecting ? `${selected ? 'Deselect' : 'Select'} ${label}` : `Open ${label}`}
        aria-pressed={selecting ? selected : undefined}
        data-photo-id={photo.id}
        onClick={() => {
          if (press.current?.fired) {
            press.current = null;
            return;
          }
          if (selecting) onToggle();
          else onOpen();
        }}
        onContextMenu={(e) => {
          if (!onStartSelect || selecting) return;
          e.preventDefault();
          onStartSelect();
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch' || !onStartSelect || selecting) return;
          press.current = { fired: false, t: setTimeout(() => {
            if (press.current) press.current.fired = true;
            onStartSelect();
            navigator.vibrate?.(15);
          }, 480) };
        }}
        onPointerUp={clear}
        onPointerMove={(e) => {
          if (e.pointerType === 'touch' && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) clear();
        }}
        onPointerCancel={clear}
        className={cn(
          'group relative block size-full overflow-hidden rounded-lg bg-surface-3 outline-none sm:rounded-xl',
          'focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          '[-webkit-touch-callout:none] select-none',
        )}
      >
        {!loaded && <span className="absolute inset-0 animate-shimmer bg-gradient-to-r from-surface-3 via-surface-2 to-surface-3 bg-[length:200%_100%]" />}
        <img
          ref={imgRef}
          src={photo.thumb_url}
          alt={photo.caption ?? ''}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          className={cn(
            'size-full object-cover transition duration-300',
            loaded ? 'opacity-100' : 'opacity-0',
            !selecting && 'group-hover:scale-[1.03]',
            selected && 'scale-[0.88] rounded-lg',
          )}
        />
        {!selecting && (photo.caption || photo.like_count > 0 || photo.comment_count > 0) && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/65 via-black/20 to-transparent px-2.5 pb-2 pt-8 text-left text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
            <span className="line-clamp-2 text-[12px] font-medium leading-snug">{photo.caption}</span>
            <span className="flex shrink-0 items-center gap-2 text-[11px] font-semibold tabular">
              {photo.like_count > 0 && (
                <span className="inline-flex items-center gap-0.5"><Heart size={12} className={photo.liked ? 'fill-current' : ''} />{photo.like_count}</span>
              )}
              {photo.comment_count > 0 && (
                <span className="inline-flex items-center gap-0.5"><MessageCircle size={12} />{photo.comment_count}</span>
              )}
            </span>
          </span>
        )}
        {!selecting && photo.like_count > 0 && (
          <span className="pointer-events-none absolute left-1.5 top-1.5 hidden items-center gap-0.5 rounded-full bg-black/35 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm max-sm:inline-flex">
            <Heart size={10} className={photo.liked ? 'fill-current' : ''} />
            {photo.like_count}
          </span>
        )}
        {selecting && (
          <span
            aria-hidden
            className={cn(
              'absolute left-2 top-2 flex size-6 items-center justify-center rounded-full border-2 transition',
              selected ? 'border-white bg-primary-solid text-white shadow-lift' : 'border-white/90 bg-black/20 text-transparent',
            )}
          >
            <Check size={14} strokeWidth={3} />
          </span>
        )}
        {selected && <span className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-inset ring-primary sm:rounded-xl" />}
      </button>
    </div>
  );
}

/** Placeholder rows while loading. */
export function GridSkeleton({ rows = 3 }: { rows?: number }) {
  const pattern = [[1.5, 1, 1.33], [1, 1.5, 0.75, 1.2], [1.33, 1.33, 1]];
  return (
    <div className="flex flex-col gap-1.5" aria-hidden>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-28 gap-1.5 sm:h-44 lg:h-52">
          {pattern[r % pattern.length].map((grow, i) => (
            <div key={i} className="animate-shimmer rounded-xl bg-gradient-to-r from-surface-3 via-surface-2 to-surface-3 bg-[length:200%_100%]" style={{ flexGrow: grow, flexBasis: 0 }} />
          ))}
        </div>
      ))}
    </div>
  );
}
