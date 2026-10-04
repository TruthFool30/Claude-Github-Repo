import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
  /** Shorthand for circles (avatars). */
  circle?: boolean;
}

/** Shimmering placeholder block. Size it with classes: <Skeleton className="h-4 w-32" /> */
export function Skeleton({ className, style, circle }: SkeletonProps) {
  return (
    <div
      aria-hidden
      style={style}
      className={cn('skeleton-shimmer animate-shimmer', circle ? 'rounded-full' : 'rounded-lg', className ?? 'h-4 w-full')}
    />
  );
}

/** A few lines of text placeholder. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: i === lines - 1 ? '60%' : `${92 - i * 6}%` }} />
      ))}
    </div>
  );
}

/** List-row placeholders (avatar + two lines), e.g. while a list loads. */
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton circle className="size-10 shrink-0" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5" style={{ width: `${70 - (i % 3) * 12}%` }} />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Card-shaped placeholder. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-2xl border border-border bg-surface p-5 shadow-card', className)} aria-hidden>
      <Skeleton className="mb-4 h-5 w-1/3" />
      <SkeletonText lines={3} />
    </div>
  );
}
