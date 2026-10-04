import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { format } from 'date-fns';
import { CheckSquare, FolderPlus, ImagePlus, Images, Inbox, LayoutGrid, Plus, Upload } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDate, firstName, plural, toDate } from '../../lib/format';
import { Avatar, Button, Card, EmptyState, Fab, PageHeader, Skeleton, Tabs } from '../../ui';
import { useAlbums, useOverview, useTimeline } from './data';
import { AlbumFormModal } from './dialogs';
import { DropOverlay, SelectionBar, UploadTargetDialog, ViewerHost, useFileDrop, useSelection, useUploadPicker, useViewerParam } from './common';
import { GridSkeleton, JustifiedGrid } from './JustifiedGrid';
import type { Album, Photo } from './types';
import { MemberStack } from './MemberStack';
import mod from './index';

export function Library({ view }: { view: 'albums' | 'all' }) {
  const navigate = useNavigate();
  const { data: overview } = useOverview();
  const [albumOpen, setAlbumOpen] = useState(false);
  const [target, setTarget] = useState<{ open: boolean; files: File[] | null }>({ open: false, files: null });
  const { pick, input } = useUploadPicker();
  const dragging = useFileDrop((files) => setTarget({ open: true, files }));

  const subtitle = overview
    ? `${plural(overview.total, 'photo')} · ${plural(overview.albums, 'album')}`
    : mod.description;

  return (
    <div>
      {input}
      <PageHeader
        title="Photos"
        subtitle={subtitle}
        icon={mod.icon}
        accent={mod.accent}
        actions={
          <>
            <Button variant="secondary" icon={FolderPlus} onClick={() => setAlbumOpen(true)} className="max-sm:hidden">
              New album
            </Button>
            <Button icon={Upload} onClick={() => setTarget({ open: true, files: null })} className="max-lg:hidden">
              Upload
            </Button>
            <Button variant="secondary" size="sm" icon={FolderPlus} onClick={() => setAlbumOpen(true)} className="sm:hidden" aria-label="New album">
              Album
            </Button>
          </>
        }
      >
        <Tabs
          accent={mod.accent}
          value={view}
          onChange={(v) => navigate(v === 'albums' ? '/photos' : '/photos/all')}
          tabs={[
            { id: 'albums', label: 'Albums', icon: LayoutGrid, count: overview?.albums },
            { id: 'all', label: 'All photos', icon: Images, count: overview?.total },
          ]}
        />
      </PageHeader>

      {view === 'albums' ? (
        <AlbumsView onNewAlbum={() => setAlbumOpen(true)} onUpload={() => setTarget({ open: true, files: null })} />
      ) : (
        <TimelineView onUpload={() => setTarget({ open: true, files: null })} />
      )}

      <Fab label="Upload photos" icon={ImagePlus} accent={mod.accent} onClick={() => setTarget({ open: true, files: null })} />
      <AlbumFormModal open={albumOpen} onClose={() => setAlbumOpen(false)} onSaved={(a) => navigate(`/photos/albums/${a.id}`)} />
      <UploadTargetDialog open={target.open} files={target.files} onClose={() => setTarget({ open: false, files: null })} onPick={pick} />
      <DropOverlay show={dragging} label="Add photos to Hearth" />
    </div>
  );
}

// ---- albums ------------------------------------------------------------------------------------------
function AlbumsView({ onNewAlbum, onUpload }: { onNewAlbum: () => void; onUpload: () => void }) {
  const { data: albums, isLoading, isError, refetch } = useAlbums();
  const { data: overview } = useOverview();
  const viewer = useViewerParam();
  const recent = overview?.recent ?? [];

  if (isLoading) {
    return (
      <div>
        <Skeleton className="mb-3 h-5 w-40" />
        <div className="mb-8 flex gap-2 overflow-hidden">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 w-24 shrink-0 rounded-xl sm:h-28 sm:w-28" />)}</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Skeleton className="aspect-[4/3] w-full rounded-2xl" />
              <Skeleton className="mt-3 h-4 w-3/4" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (isError) {
    return <EmptyState icon={Images} accent={mod.accent} title="Couldn't load albums" description="Check your connection and try again." action={<Button onClick={() => refetch()}>Try again</Button>} />;
  }
  if (!albums?.length && !overview?.total) {
    return (
      <Card padding="none" className="overflow-hidden">
        <EmptyState
          icon={Images}
          accent={mod.accent}
          title="Your family's memories live here"
          description="Create an album for a trip, a birthday or everyday moments, and everyone can add their photos."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon={Upload} onClick={onUpload}>Upload photos</Button>
              <Button variant="secondary" icon={FolderPlus} onClick={onNewAlbum}>Create an album</Button>
            </div>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {recent.length > 0 && (
        <section aria-labelledby="recent-h">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="recent-h" className="text-[17px] font-bold tracking-tight text-fg">Recently added</h2>
            <Link to="/photos/all" className="text-sm font-semibold text-primary hover:underline">See all</Link>
          </div>
          <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 sm:gap-3">
            {recent.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => viewer.open(p.id)}
                aria-label={`Open ${p.caption || 'photo'}${p.uploader ? ` by ${p.uploader.name}` : ''}`}
                className="group relative size-24 shrink-0 snap-start overflow-hidden rounded-xl bg-surface-3 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring sm:size-28 lg:size-32"
              >
                <img src={p.thumb_url} alt="" loading="lazy" className="size-full object-cover transition duration-300 group-hover:scale-105" />
                {p.uploader && (
                  <span className="absolute bottom-1.5 left-1.5 rounded-full ring-2 ring-white/80">
                    <Avatar user={p.uploader} size="xs" />
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="albums-h">
        <h2 id="albums-h" className="mb-3 text-[17px] font-bold tracking-tight text-fg">Albums</h2>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 lg:grid-cols-4">
          {(albums ?? []).map((a) => <AlbumCard key={a.id} album={a} />)}
          {!!overview?.unsorted && (
            <li>
              <Link to="/photos/all?album=none" className="group block rounded-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
                <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-border">
                  <Inbox size={30} className="text-subtle transition group-hover:scale-110" />
                </div>
                <p className="mt-2.5 truncate text-[15px] font-semibold text-fg">Not in an album</p>
                <p className="text-[13px] text-muted">{plural(overview.unsorted, 'photo')}</p>
              </Link>
            </li>
          )}
          <li>
            <button
              type="button"
              onClick={onNewAlbum}
              className="group flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border-strong text-muted transition hover:border-[var(--acc)] hover:text-[var(--acc)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
              style={{ ['--acc' as string]: mod.accent }}
            >
              <span className="flex size-11 items-center justify-center rounded-full bg-surface-2 transition group-hover:scale-110"><Plus size={22} /></span>
              <span className="text-sm font-semibold">New album</span>
            </button>
          </li>
        </ul>
      </section>
      <ViewerHost photos={recent} viewer={viewer} ready={!!overview} />
    </div>
  );
}

/** "Aug 14 – 17, 2026", "Jun 21, 2026", "Dec 28, 2025 – Jan 2, 2026" — from the photos, else the album date. */
export function albumDateLabel(a: Pick<Album, 'event_date' | 'first_taken_at' | 'last_taken_at'>) {
  const f = toDate(a.first_taken_at);
  const l = toDate(a.last_taken_at);
  if (!f || !l) return a.event_date ? fmtDate(a.event_date, 'MMM d, yyyy') : null;
  const y = (d: Date) => format(d, 'yyyy');
  if (format(f, 'yyyy-MM-dd') === format(l, 'yyyy-MM-dd')) return format(f, 'MMM d, yyyy');
  if (format(f, 'yyyy-MM') === format(l, 'yyyy-MM')) return `${format(f, 'MMM d')} – ${format(l, 'd')}, ${y(l)}`;
  if (y(f) === y(l)) return `${format(f, 'MMM d')} – ${format(l, 'MMM d')}, ${y(l)}`;
  return `${format(f, 'MMM d, yyyy')} – ${format(l, 'MMM d, yyyy')}`;
}

function AlbumCard({ album }: { album: Album }) {
  const { members } = useAuth();
  const contributors = album.contributor_ids.map((id) => members.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  const date = albumDateLabel(album);
  const minis = album.preview.filter((p) => p.id !== album.cover?.id).slice(0, 2);
  return (
    <li>
      <Link to={`/photos/albums/${album.id}`} className="group block rounded-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring" aria-label={`${album.title}, ${plural(album.photo_count, 'photo')}`}>
        <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-surface-3 shadow-card ring-1 ring-black/5 transition duration-300 group-hover:-translate-y-0.5 group-hover:shadow-lift dark:ring-white/5">
          {album.cover ? (
            <img src={album.cover.thumb_url} alt="" loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.04]" />
          ) : (
            <div className="flex size-full items-center justify-center" style={{ background: `linear-gradient(135deg, color-mix(in oklab, ${mod.accent} 22%, var(--surface-2)), var(--surface-3))` }}>
              <Images size={30} style={{ color: mod.accent }} />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
          {minis.length === 2 && (
            <div className="absolute right-2 top-2 hidden flex-col gap-1 sm:flex">
              {minis.map((m) => <img key={m.id} src={m.thumb_url} alt="" loading="lazy" className="size-9 rounded-md object-cover ring-2 ring-white/90 shadow" />)}
            </div>
          )}
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
            <Images size={11} /> {album.photo_count}
          </span>
          {contributors.length > 0 && (
            <div className="absolute bottom-2 right-2">
              <MemberStack users={contributors} max={3} size={22} ringClass="ring-white/85" />
            </div>
          )}
        </div>
        <p className="mt-2.5 line-clamp-2 text-[15px] font-semibold leading-snug text-fg [overflow-wrap:anywhere] group-hover:text-primary">{album.title}</p>
        <p className="truncate text-[13px] text-muted">{date ?? (album.photo_count ? '' : 'Empty album')}</p>
      </Link>
    </li>
  );
}

// ---- timeline ------------------------------------------------------------------------------------------
function TimelineView({ onUpload }: { onUpload: () => void }) {
  const [params, setParams] = useSearchParams();
  const { members } = useAuth();
  const album = params.get('album') === 'none' ? 'none' : undefined;
  const member = Number(params.get('member')) || null;
  const viewer = useViewerParam();
  // A deep link (?photo=) may point beyond the first page: ask the server to load up to it.
  const [deepLink] = useState(() => viewer.openId);
  const q = useTimeline({ album, member }, deepLink);
  const selection = useSelection();
  const sentinel = useRef<HTMLDivElement>(null);
  const photos = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const months = q.data?.pages[0]?.months ?? [];
  const total = q.data?.pages[0]?.total ?? 0;

  const groups = useMemo(() => {
    // Grouped by the photo's LOCAL capture month (same key the server counts by).
    const byKey = new Map<string, Photo[]>();
    for (const p of photos) {
      const key = (p.taken_date || p.taken_at).slice(0, 7);
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
    return [...byKey].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([key, list]) => ({ key, photos: list }));
  }, [photos]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  // The viewer browses in the same order as the grid (month groups, newest first).
  const viewerPhotos = useMemo(() => groups.flatMap((g) => g.photos), [groups]);
  const needMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  // An open photo that isn't loaded yet (e.g. deep link into an older page): keep paging until it is.
  useEffect(() => {
    if (viewer.openId && !q.isLoading && !viewerPhotos.some((p) => p.id === viewer.openId)) needMore();
  }, [viewer.openId, q.isLoading, viewerPhotos, needMore]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && !isFetchingNextPage && fetchNextPage(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const setFilter = (k: string, v: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v) n.set(k, v);
      else n.delete(k);
      n.delete('photo');
      return n;
    }, { replace: true });

  const chip = (active: boolean) =>
    cn(
      'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
      active ? 'border-transparent bg-fg text-bg' : 'border-border bg-surface text-muted hover:bg-surface-2 hover:text-fg',
    );

  return (
    <div className={cn(selection.selecting && 'pb-24')}>
      <div className="mb-5 flex items-center gap-2">
        <div
          className="-mx-4 flex min-w-0 flex-1 gap-2 overflow-x-auto px-4 py-0.5 pr-8 [mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)] [scrollbar-width:none] sm:mx-0 sm:px-0 sm:pr-8"
          role="group"
          aria-label="Filter photos"
        >
          <button type="button" className={chip(!member && !album)} aria-pressed={!member && !album} onClick={() => setParams({}, { replace: true })}>Everyone</button>
          {members.map((m) => (
            <button key={m.id} type="button" className={chip(member === m.id)} aria-pressed={member === m.id} onClick={() => setFilter('member', member === m.id ? null : String(m.id))}>
              <Avatar user={m} size="xs" /> {firstName(m.name)}
            </button>
          ))}
          <button type="button" className={chip(album === 'none')} aria-pressed={album === 'none'} onClick={() => setFilter('album', album ? null : 'none')}>
            <Inbox size={14} /> Not in an album
          </button>
        </div>
        {photos.length > 0 && !selection.selecting && (
          <Button variant="secondary" size="sm" icon={CheckSquare} onClick={() => selection.start()} className="shrink-0">
            <span className="max-sm:sr-only">Select</span>
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <>
          <Skeleton className="mb-3 h-5 w-36" />
          <GridSkeleton rows={4} />
        </>
      ) : q.isError ? (
        <EmptyState icon={Images} accent={mod.accent} title="Couldn't load photos" description="Check your connection and try again." action={<Button onClick={() => q.refetch()}>Try again</Button>} />
      ) : !photos.length ? (
        <EmptyState
          icon={album ? Inbox : Images}
          accent={mod.accent}
          title={album ? 'Everything is sorted' : member ? 'No photos from them yet' : 'No photos yet'}
          description={album ? 'Every photo is in an album. Nice and tidy!' : 'Upload your first photos and the whole family will see them here.'}
          action={!album && <Button icon={Upload} onClick={onUpload}>Upload photos</Button>}
        />
      ) : (
        <div className="space-y-7">
          <p className="sr-only" aria-live="polite">{plural(total, 'photo')}</p>
          {groups.map((g) => {
            const count = months.find((m) => m.month === g.key)?.count ?? g.photos.length;
            const [y, mo] = g.key.split('-').map(Number);
            return (
              <section key={g.key} aria-label={format(new Date(y, mo - 1, 1), 'MMMM yyyy')}>
                <div className="sticky top-[calc(56px+env(safe-area-inset-top))] z-10 -mx-4 mb-2.5 flex items-baseline gap-2 bg-bg/85 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 lg:top-16 lg:-mx-10 lg:px-10">
                  <h2 className="text-[17px] font-bold tracking-tight text-fg">{format(new Date(y, mo - 1, 1), y === new Date().getFullYear() ? 'MMMM' : 'MMMM yyyy')}</h2>
                  <span className="text-[13px] text-muted">{plural(count, 'photo')}</span>
                </div>
                <JustifiedGrid
                  photos={g.photos}
                  onOpen={(i) => viewer.open(g.photos[i].id)}
                  selecting={selection.selecting}
                  selected={selection.selected}
                  onToggle={selection.toggle}
                  onStartSelect={(id) => selection.start(id)}
                />
              </section>
            );
          })}
          <div ref={sentinel} className="flex justify-center py-4">
            {q.hasNextPage ? (
              <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button>
            ) : photos.length > 12 ? (
              <p className="text-sm text-subtle">That's everything — {plural(total, 'photo')}</p>
            ) : null}
          </div>
        </div>
      )}
      <SelectionBar selection={selection} photos={photos} />
      <ViewerHost
        photos={viewerPhotos}
        viewer={viewer}
        ready={!q.isLoading && !q.isFetchingNextPage && (!q.hasNextPage || viewerPhotos.some((p) => p.id === viewer.openId))}
        total={total}
        onNeedMore={needMore}
      />
    </div>
  );
}
