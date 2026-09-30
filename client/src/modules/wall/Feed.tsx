import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity as ActivityIcon, Images, LayoutList, MessageSquareText, PenLine, RefreshCw, Sparkles } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import type { Activity } from '../../lib/types';
import { Button, Card, EmptyState, SegmentedControl, Skeleton, SkeletonText, Spinner } from '../../ui';
import { useFeed } from './api';
import { ActivityCard } from './ActivityCard';
import { PostCard } from './PostCard';
import type { FeedFilter, WallPost } from './types';

const FILTER_KEY = 'hearth-wall-filter';
const FILTERS: Array<{ value: FeedFilter; label: string; icon: typeof LayoutList }> = [
  { value: 'all', label: 'All', icon: LayoutList },
  { value: 'posts', label: 'Posts', icon: MessageSquareText },
  { value: 'photos', label: 'Photos', icon: Images },
  { value: 'activity', label: 'Updates', icon: ActivityIcon },
];

function readFilter(): FeedFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return FILTERS.some((f) => f.value === v) ? (v as FeedFilter) : 'all';
  } catch {
    return 'all';
  }
}

type Block = { kind: 'post'; key: string; post: WallPost } | { kind: 'activity'; key: string; items: Activity[] };

export function Feed({ onCompose, onEdit, accent }: { onCompose: () => void; onEdit: (p: WallPost) => void; accent: string }) {
  const [filter, setFilter] = useState<FeedFilter>(readFilter);
  const feed = useFeed(filter);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, filter);
    } catch {
      /* ignore */
    }
  }, [filter]);

  // Infinite scroll: load the next page when the sentinel nears the viewport.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const pinned = feed.data?.pages[0]?.pinned ?? [];
  const blocks = useMemo(() => {
    const out: Block[] = [];
    const seen = new Set<string>();
    for (const page of feed.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        if (item.type === 'post') out.push({ kind: 'post', key: item.key, post: item.post });
        else {
          const prev = out[out.length - 1];
          // Group consecutive updates (max 6 per card) so posts stay the stars of the feed.
          if (prev?.kind === 'activity' && prev.items.length < 6) prev.items.push(item.activity);
          else out.push({ kind: 'activity', key: item.key, items: [item.activity] });
        }
      }
    }
    return out;
  }, [feed.data]);

  const empty = !feed.isPending && !feed.isError && blocks.length === 0 && pinned.length === 0;

  return (
    <section aria-label="Family feed" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight text-fg">Family feed</h2>
        {feed.isFetching && !feed.isPending && !isFetchingNextPage && <Spinner size={16} className="text-subtle" />}
      </div>
      <SegmentedControl
        options={FILTERS.map((f) => ({ value: f.value, label: f.label, icon: f.icon }))}
        value={filter}
        onChange={setFilter}
        size="sm"
        block
        aria-label="Filter the feed"
        className="mb-4"
      />

      {feed.isPending ? (
        <FeedSkeleton />
      ) : feed.isError ? (
        <Card className="text-center">
          <EmptyState
            compact
            icon={RefreshCw}
            title="Couldn't load the feed"
            description={errorMessage(feed.error) || 'Check your connection and try again.'}
            action={<Button variant="secondary" icon={RefreshCw} onClick={() => void feed.refetch()}>Try again</Button>}
          />
        </Card>
      ) : empty ? (
        <Card>
          <EmptyState
            icon={filter === 'photos' ? Images : filter === 'activity' ? Sparkles : PenLine}
            accent={accent}
            title={
              filter === 'photos' ? 'No photos yet' : filter === 'activity' ? 'No updates yet' : 'Your family wall is ready'
            }
            description={
              filter === 'activity'
                ? 'When someone adds an event, checks off a list item or shares an album, it shows up here.'
                : filter === 'photos'
                  ? 'Share a snapshot from today — everyone in the family will see it.'
                  : 'Share news, photos and little moments. Everyone in the family sees it and can react.'
            }
            action={filter !== 'activity' && <Button icon={PenLine} onClick={onCompose}>Write the first post</Button>}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {pinned.map((p) => (
            <PostCard key={`pin${p.id}`} post={p} onEdit={onEdit} className="animate-fade-in" />
          ))}
          {blocks.map((b) =>
            b.kind === 'post' ? (
              <PostCard key={b.key} post={b.post} onEdit={onEdit} className="animate-fade-in" />
            ) : (
              <ActivityCard key={b.key} items={b.items} />
            ),
          )}
          <div ref={sentinel} aria-hidden />
          {hasNextPage ? (
            <div className="flex justify-center py-2">
              <Button variant="secondary" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : (
            <p className="flex items-center justify-center gap-2 py-4 text-sm text-subtle">
              <span className="h-px w-10 bg-border" /> You're all caught up <span className="h-px w-10 bg-border" />
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading the feed">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5" aria-hidden>
          <div className="flex items-center gap-3">
            <Skeleton circle className="size-9" />
            <div className="flex-1">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="mt-2 h-3 w-20" />
            </div>
          </div>
          <SkeletonText lines={2} className="mt-4" />
          {i === 0 && <Skeleton className="mt-4 aspect-[2/1] w-full rounded-xl" />}
          <div className="mt-4 flex gap-2 border-t border-border pt-3">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}
