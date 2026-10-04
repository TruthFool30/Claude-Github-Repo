import { useCallback } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { ApiError, FAMILY_LOST_EVENT, UNAUTHORIZED_EVENT, api, errorMessage, getApiFamily, isFamilyLost, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLive } from '../../lib/live';
import { toast } from '../../ui';
import type { Activity } from '../../lib/types';
import type { Dashboard, FeedFilter, FeedPage, WallComment, WallPost } from './types';

export const wallKeys = {
  all: ['wall'] as const,
  feeds: ['wall', 'feed'] as const,
  feed: (filter: FeedFilter) => ['wall', 'feed', filter] as const,
  post: (id: number) => ['wall', 'post', id] as const,
  dashboard: ['wall', 'dashboard'] as const,
};

export const PAGE_SIZE = 12;

/**
 * Multipart request with upload progress (fetch has none). Mirrors lib/api's headers and errors:
 * X-Family-Id / X-Timezone, ApiError on failure, the same 401 / NOT_MEMBER events.
 */
export function uploadWithProgress<T>(method: 'POST' | 'PATCH', path: string, body: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `/api${path}`);
    const fid = getApiFamily();
    if (fid) xhr.setRequestHeader('X-Family-Id', String(fid));
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) xhr.setRequestHeader('X-Timezone', tz);
    } catch {
      /* no Intl zone */
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error — check your connection and try again'));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
      const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `Request failed (${xhr.status})`;
      const err = new ApiError(xhr.status, message, data);
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      if (isFamilyLost(err)) window.dispatchEvent(new CustomEvent(FAMILY_LOST_EVENT, { detail: { familyId: fid } }));
      reject(err);
    };
    xhr.send(body);
  });
}

export function useFeed(filter: FeedFilter) {
  return useInfiniteQuery({
    queryKey: wallKeys.feed(filter),
    queryFn: ({ pageParam }) => api.get<FeedPage>(`/wall/feed${qs({ filter, limit: PAGE_SIZE, before: pageParam })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function usePost(id: number) {
  return useQuery({
    queryKey: wallKeys.post(id),
    queryFn: () => api.get<WallPost>(`/wall/posts/${id}`),
    enabled: Number.isInteger(id) && id > 0,
    retry: (count, err) => !(err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) && count < 2,
  });
}

/** GET /api/dashboard — optional keys from other modules. Never throws into the UI. */
export function useDashboard() {
  return useQuery({
    queryKey: wallKeys.dashboard,
    queryFn: async () => {
      const data = await api.get<Dashboard>('/dashboard');
      return data && typeof data === 'object' ? data : {};
    },
    staleTime: 30_000,
  });
}

type Feeds = InfiniteData<FeedPage>;

/**
 * Put a (new or changed) post where it belongs in every cached feed without refetching:
 * pinned list vs. stream, newest-first order, photos filter membership. Posts older than the
 * loaded window are left for pagination to bring in.
 */
export function placePost(qc: QueryClient, post: WallPost) {
  const byFilter: FeedFilter[] = ['all', 'posts', 'photos'];
  for (const filter of byFilter) {
    qc.setQueryData<Feeds>(wallKeys.feed(filter), (data) => {
      if (!data?.pages.length) return data;
      const key = `p${post.id}`;
      let pages = data.pages.map((pg) => ({
        ...pg,
        pinned: pg.pinned?.filter((p) => p.id !== post.id),
        items: pg.items.filter((i) => i.key !== key),
      }));
      const belongs = filter !== 'photos' || post.photos.length > 0;
      if (!belongs) return { ...data, pages };
      if (filter !== 'photos' && post.pinned) {
        const first = pages[0];
        const pinned = [post, ...(first.pinned ?? [])].sort((a, b) => (b.pinned_at ?? '').localeCompare(a.pinned_at ?? ''));
        pages = [{ ...first, pinned }, ...pages.slice(1)];
        return { ...data, pages };
      }
      const item = { type: 'post' as const, key, created_at: post.created_at, post };
      for (let i = 0; i < pages.length; i++) {
        const items = pages[i].items;
        const at = items.findIndex((it) => it.created_at < post.created_at);
        const isLast = i === pages.length - 1;
        if (at >= 0 || (isLast && !pages[i].next_cursor)) {
          const idx = at >= 0 ? at : items.length;
          pages[i] = { ...pages[i], items: [...items.slice(0, idx), item, ...items.slice(idx)] };
          break;
        }
      }
      return { ...data, pages };
    });
  }
  qc.setQueryData<WallPost>(wallKeys.post(post.id), (old) => (old ? post : old));
}

/** Newest activity entry (from another module) goes on top of the "all" and "activity" feeds. */
function placeActivity(qc: QueryClient, activity: Activity) {
  for (const filter of ['all', 'activity'] as const) {
    qc.setQueryData<Feeds>(wallKeys.feed(filter), (data) => {
      if (!data?.pages.length) return data;
      const key = `a${activity.id}`;
      if (data.pages.some((pg) => pg.items.some((i) => i.key === key))) return data;
      const [first, ...rest] = data.pages;
      return { ...data, pages: [{ ...first, items: [{ type: 'activity', key, created_at: activity.created_at, activity }, ...first.items] }, ...rest] };
    });
  }
}

/**
 * Keep the Home page live. Wall and activity events patch the cache from their payloads
 * (no refetch of every loaded page); dashboard sources simply refresh the small dashboard query.
 */
export function useWallLive() {
  const qc = useQueryClient();
  const { user } = useAuth();
  useLive<unknown>(
    'wall',
    (e) => {
      const p = e.payload as Record<string, unknown>;
      switch (e.type) {
        case 'wall.post.created':
        case 'wall.post.updated':
        case 'wall.post.pinned':
          placePost(qc, p as unknown as WallPost);
          break;
        case 'wall.post.deleted':
          patchPost(qc, Number(p.id), () => null);
          break;
        case 'wall.reaction.updated':
          patchPost(qc, Number(p.post_id), (post) => ({ ...post, reactions: p.reactions as WallPost['reactions'] }));
          break;
        case 'wall.comment.created': {
          const c = p.comment as WallComment;
          patchPost(qc, c.post_id, (post) => {
            if (post.comments.some((x) => x.id === c.id)) return post;
            // Our own optimistic copy may still be pending: swap it for the real one.
            const temp = post.comments.find((x) => x.pending && x.user_id === user?.id && x.body === c.body);
            const comments = temp ? post.comments.map((x) => (x === temp ? c : x)) : [...post.comments, c];
            return { ...post, comments, comment_count: comments.length };
          });
          break;
        }
        case 'wall.comment.updated': {
          const c = p.comment as WallComment;
          patchPost(qc, c.post_id, (post) => ({ ...post, comments: post.comments.map((x) => (x.id === c.id ? c : x)) }));
          break;
        }
        case 'wall.comment.deleted': {
          const id = Number(p.id);
          patchPost(qc, Number(p.post_id), (post) => {
            const comments = post.comments.filter((x) => x.id !== id && x.parent_id !== id);
            return { ...post, comments, comment_count: comments.length };
          });
          break;
        }
        default:
          void qc.invalidateQueries({ queryKey: wallKeys.all });
      }
    },
    { invalidate: false },
  );
  useLive<Activity>(
    'activity',
    (e) => {
      if (!e.payload) return;
      if (e.type === 'activity') {
        if (e.payload.module !== 'wall') placeActivity(qc, e.payload);
      } else if (e.type === 'activity.removed' || e.type === 'activity.updated') {
        // Another module retracted or rewrote an entry (e.g. a document became private).
        const p = e.payload as Activity & { ids?: number[] };
        const keys = new Set((Array.isArray(p.ids) ? p.ids : [p.id]).map((id) => `a${id}`));
        const removed = e.type === 'activity.removed';
        qc.setQueriesData<Feeds>({ queryKey: wallKeys.feeds }, (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((pg) => ({
                  ...pg,
                  items: pg.items.flatMap((it) =>
                    !keys.has(it.key) || it.type !== 'activity' ? [it] : removed ? [] : [{ ...it, activity: { ...it.activity, ...e.payload } }],
                  ),
                })),
              }
            : data,
        );
      }
    },
    { invalidate: false },
  );
  useLive('calendar', undefined, { queryKey: wallKeys.dashboard });
  useLive('lists', undefined, { queryKey: wallKeys.dashboard });
  useLive('meals', undefined, { queryKey: wallKeys.dashboard });
}

/** Apply `fn` to a post wherever it is cached (every feed filter + detail). Return null to remove it. */
export function patchPost(qc: QueryClient, id: number, fn: (p: WallPost) => WallPost | null) {
  const mapList = (list: WallPost[]) => list.flatMap((p) => (p.id === id ? (fn(p) ? [fn(p) as WallPost] : []) : [p]));
  qc.setQueriesData<InfiniteData<FeedPage>>({ queryKey: wallKeys.feeds }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((pg) => ({
            ...pg,
            pinned: pg.pinned ? mapList(pg.pinned) : pg.pinned,
            items: pg.items.flatMap((it) => {
              if (it.type !== 'post' || it.post.id !== id) return [it];
              const next = fn(it.post);
              return next ? [{ ...it, post: next }] : [];
            }),
          })),
        }
      : data,
  );
  qc.setQueryData<WallPost>(wallKeys.post(id), (old) => (old ? fn(old) ?? old : old));
}

/** All post/comment/reaction actions with optimistic updates and friendly errors. */
export function useWallActions() {
  const qc = useQueryClient();
  const { user } = useAuth();

  const settle = useCallback(() => qc.invalidateQueries({ queryKey: wallKeys.all }), [qc]);
  const fail = useCallback(
    (e: unknown) => {
      toast.error(errorMessage(e));
      void settle();
    },
    [settle],
  );

  const react = useCallback(
    async (post: WallPost, emoji: string | null) => {
      if (!user) return;
      await qc.cancelQueries({ queryKey: wallKeys.all });
      patchPost(qc, post.id, (p) => {
        const others = p.reactions.filter((r) => r.user_id !== user.id);
        return { ...p, reactions: emoji ? [...others, { emoji, user_id: user.id, created_at: new Date().toISOString() }] : others };
      });
      try {
        const next = emoji
          ? await api.put<WallPost>(`/wall/posts/${post.id}/reaction`, { emoji })
          : await api.del<WallPost>(`/wall/posts/${post.id}/reaction`);
        patchPost(qc, post.id, (p) => ({ ...p, reactions: next.reactions }));
      } catch (e) {
        fail(e);
      }
    },
    [qc, user, fail],
  );

  const addComment = useCallback(
    async (post: WallPost, body: string, parentId: number | null) => {
      if (!user) return false;
      const temp: WallComment = {
        id: -Date.now(), post_id: post.id, parent_id: parentId, user_id: user.id, body,
        created_at: new Date().toISOString(), edited_at: null, author: user, pending: true,
      };
      await qc.cancelQueries({ queryKey: wallKeys.all });
      patchPost(qc, post.id, (p) => ({ ...p, comments: [...p.comments, temp], comment_count: p.comment_count + 1 }));
      try {
        const saved = await api.post<WallComment>(`/wall/posts/${post.id}/comments`, { body, parent_id: parentId });
        patchPost(qc, post.id, (p) => ({ ...p, comments: p.comments.map((c) => (c.id === temp.id ? saved : c)) }));
        return true;
      } catch (e) {
        patchPost(qc, post.id, (p) => ({ ...p, comments: p.comments.filter((c) => c.id !== temp.id), comment_count: p.comment_count - 1 }));
        toast.error(errorMessage(e));
        return false;
      }
    },
    [qc, user],
  );

  const editComment = useCallback(
    async (c: WallComment, body: string) => {
      patchPost(qc, c.post_id, (p) => ({ ...p, comments: p.comments.map((x) => (x.id === c.id ? { ...x, body, edited_at: new Date().toISOString() } : x)) }));
      try {
        await api.patch(`/wall/comments/${c.id}`, { body });
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [qc, fail],
  );

  const deleteComment = useCallback(
    async (c: WallComment) => {
      patchPost(qc, c.post_id, (p) => {
        const comments = p.comments.filter((x) => x.id !== c.id && x.parent_id !== c.id);
        return { ...p, comments, comment_count: comments.length };
      });
      try {
        await api.del(`/wall/comments/${c.id}`);
        toast.success('Comment deleted');
      } catch (e) {
        fail(e);
      }
    },
    [qc, fail],
  );

  const deletePost = useCallback(
    async (post: WallPost) => {
      await qc.cancelQueries({ queryKey: wallKeys.all });
      patchPost(qc, post.id, () => null);
      try {
        await api.del(`/wall/posts/${post.id}`);
        toast.success('Post deleted');
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [qc, fail],
  );

  const pin = useCallback(
    async (post: WallPost, pinned: boolean) => {
      patchPost(qc, post.id, (p) => ({ ...p, pinned }));
      try {
        const saved = await api.put<WallPost>(`/wall/posts/${post.id}/pin`, { pinned });
        placePost(qc, saved);
        toast.success(pinned ? 'Pinned to the top of the wall' : 'Post unpinned');
      } catch (e) {
        fail(e);
      }
    },
    [qc, fail],
  );

  return { react, addComment, editComment, deleteComment, deletePost, pin };
}
