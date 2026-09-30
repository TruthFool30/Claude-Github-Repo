// Data layer for the lists module: queries, optimistic mutations and live-sync coordination.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, errorMessage, qs } from '../../lib/api';
import { useLive } from '../../lib/live';
import { toast } from '../../ui';
import type { ItemInput, ListDetail, ListItem, ListSummary, ListType, MyTasks } from './types';

export const keys = {
  all: ['lists'] as const,
  lists: ['lists', 'all'] as const,
  detail: (id: number) => ['lists', 'detail', id] as const,
  tasks: (userId: number) => ['lists', 'my-tasks', userId] as const,
  badge: ['lists', 'badge'] as const,
};

// "Today" is computed server-side from the X-Timezone header the api client sends.

export function useLists() {
  return useQuery({ queryKey: keys.lists, queryFn: () => api.get<ListSummary[]>(`/lists`) });
}

export function useList(id: number) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => api.get<ListDetail>(`/lists/${id}`),
    enabled: Number.isInteger(id) && id > 0,
    retry: (n, err) => (err as { status?: number })?.status !== 404 && n < 2,
  });
}

export function useMyTasks(userId: number | null | undefined) {
  return useQuery({
    queryKey: keys.tasks(userId ?? 0),
    queryFn: () => api.get<MyTasks>(`/lists/my-tasks${qs({ user_id: userId })}`),
    enabled: !!userId,
  });
}

/** Nav badge: my overdue + due-today tasks. Side-effect free; shares one query. */
export function useListsBadge(): number | undefined {
  useLive('lists', undefined, { queryKey: keys.badge });
  const { data } = useQuery({
    queryKey: keys.badge,
    queryFn: () => api.get<{ attention: number }>(`/lists/my-tasks/count`),
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
  return data?.attention;
}

// ---- live sync ------------------------------------------------------------------------------
// While our own optimistic writes are in flight, a live event would trigger a refetch that
// returns the server state *between* our writes and makes checkboxes flicker. So: defer
// invalidation until our last pending write settles, then refetch once.
let pendingWrites = 0;

export function useListsLive() {
  const qc = useQueryClient();
  useLive(
    'lists',
    () => {
      // Our pending write will refetch everything when it settles.
      if (pendingWrites === 0) void qc.invalidateQueries({ queryKey: keys.all });
    },
    { invalidate: false },
  );
}

export async function write<T>(qc: QueryClient, fn: () => Promise<T>): Promise<T> {
  pendingWrites++;
  try {
    return await fn();
  } finally {
    pendingWrites--;
    if (pendingWrites === 0) {
      void qc.invalidateQueries({ queryKey: keys.all });
    }
  }
}

// ---- optimistic helpers -----------------------------------------------------------------------

function patchDetail(qc: QueryClient, listId: number, fn: (d: ListDetail) => ListDetail) {
  qc.setQueryData<ListDetail>(keys.detail(listId), (d) => (d ? recount(fn(d)) : d));
}

function recount(d: ListDetail): ListDetail {
  const done = d.items.filter((i) => i.done).length;
  return { ...d, item_count: d.items.length, done_count: done, open_count: d.items.length - done };
}

function patchTasks(qc: QueryClient, itemId: number, patch: Partial<ListItem>) {
  for (const [key, data] of qc.getQueriesData<MyTasks>({ queryKey: ['lists', 'my-tasks'] })) {
    if (!data) continue;
    const map = (arr: MyTasks['today']) => arr.map((t) => (t.id === itemId ? { ...t, ...patch } : t));
    qc.setQueryData<MyTasks>(key, { ...data, overdue: map(data.overdue), today: map(data.today), upcoming: map(data.upcoming), someday: map(data.someday) });
  }
}

export function useListActions() {
  const qc = useQueryClient();

  const updateItem = useCallback(
    async (listId: number, itemId: number, patch: ItemInput, meId?: number) => {
      await qc.cancelQueries({ queryKey: keys.all });
      const prevDetail = qc.getQueryData<ListDetail>(keys.detail(listId));
      const local: Partial<ListItem> = { ...patch } as Partial<ListItem>;
      if (patch.done === true) Object.assign(local, { done_by: meId ?? null, done_at: new Date().toISOString() });
      if (patch.done === false) Object.assign(local, { done_by: null, done_at: null });
      if (patch.list_id && patch.list_id !== listId) {
        patchDetail(qc, listId, (d) => ({ ...d, items: d.items.filter((i) => i.id !== itemId) }));
      } else {
        patchDetail(qc, listId, (d) => ({ ...d, items: d.items.map((i) => (i.id === itemId ? { ...i, ...local } : i)) }));
      }
      patchTasks(qc, itemId, local);
      try {
        return await write(qc, () => api.patch<ListItem>(`/lists/${listId}/items/${itemId}`, patch));
      } catch (e) {
        if (prevDetail) qc.setQueryData(keys.detail(listId), prevDetail);
        toast.error(errorMessage(e));
        throw e;
      }
    },
    [qc],
  );

  const addItem = useCallback(
    async (listId: number, input: ItemInput & { text: string }, meId?: number) => {
      await qc.cancelQueries({ queryKey: keys.detail(listId) });
      const tempId = -Math.floor(Math.random() * 1e9);
      const now = new Date().toISOString();
      patchDetail(qc, listId, (d) => ({
        ...d,
        items: [
          ...d.items,
          {
            id: tempId, list_id: listId, family_id: d.family_id, text: input.text, quantity: input.quantity ?? null,
            notes: input.notes ?? null, category: input.category ?? null, assignee_id: input.assignee_id ?? null,
            due_date: input.due_date ?? null, done: false, done_by: null, done_at: null,
            position: Math.max(-1, ...d.items.map((i) => i.position)) + 1, created_by: meId ?? null,
            created_at: now, updated_at: now, can_edit: true, can_edit_notes: true, can_delete: true,
          },
        ],
      }));
      try {
        const saved = await write(qc, () => api.post<ListItem>(`/lists/${listId}/items`, input));
        patchDetail(qc, listId, (d) => ({ ...d, items: d.items.map((i) => (i.id === tempId ? saved : i)) }));
        return saved;
      } catch (e) {
        patchDetail(qc, listId, (d) => ({ ...d, items: d.items.filter((i) => i.id !== tempId) }));
        toast.error(errorMessage(e));
        throw e;
      }
    },
    [qc],
  );

  const deleteItem = useCallback(
    async (listId: number, item: ListItem, { undo = true }: { undo?: boolean } = {}) => {
      await qc.cancelQueries({ queryKey: keys.all });
      const prev = qc.getQueryData<ListDetail>(keys.detail(listId));
      patchDetail(qc, listId, (d) => ({ ...d, items: d.items.filter((i) => i.id !== item.id) }));
      try {
        await write(qc, () => api.del(`/lists/${listId}/items/${item.id}`));
        if (undo) {
          toast.success(`Removed “${item.text}”`, {
            action: {
              label: 'Undo',
              onClick: () => {
                // Server-side restore brings back the exact row (creator, done state, position) quietly.
                patchDetail(qc, listId, (d) =>
                  d.items.some((i) => i.id === item.id)
                    ? d
                    : { ...d, items: [...d.items, item].sort((x, y) => x.position - y.position || x.id - y.id) },
                );
                void write(qc, () => api.post<ListItem>(`/lists/${listId}/items/${item.id}/restore`)).catch((e) => {
                  patchDetail(qc, listId, (d) => ({ ...d, items: d.items.filter((i) => i.id !== item.id) }));
                  toast.error(errorMessage(e));
                });
              },
            },
          });
        }
      } catch (e) {
        if (prev) qc.setQueryData(keys.detail(listId), prev);
        toast.error(errorMessage(e));
      }
    },
    [qc],
  );

  const reorder = useCallback(
    async (listId: number, ids: number[]) => {
      await qc.cancelQueries({ queryKey: keys.detail(listId) });
      const prev = qc.getQueryData<ListDetail>(keys.detail(listId));
      const pos = new Map(ids.map((id, i) => [id, i]));
      patchDetail(qc, listId, (d) => ({
        ...d,
        items: d.items.map((i) => ({ ...i, position: pos.get(i.id) ?? i.position })).sort((a, b) => a.position - b.position),
      }));
      try {
        await write(qc, () => api.put(`/lists/${listId}/items/order`, { ids: ids.filter((id) => id > 0) }));
      } catch (e) {
        if (prev) qc.setQueryData(keys.detail(listId), prev);
        toast.error(errorMessage(e));
      }
    },
    [qc],
  );

  const bulkDone = useCallback(
    async (listId: number, action: 'clear-completed' | 'uncheck-all') => {
      await qc.cancelQueries({ queryKey: keys.detail(listId) });
      const prev = qc.getQueryData<ListDetail>(keys.detail(listId));
      patchDetail(qc, listId, (d) => ({
        ...d,
        items:
          action === 'clear-completed'
            ? d.items.filter((i) => !i.done)
            : d.items.map((i) => ({ ...i, done: false, done_by: null, done_at: null })),
      }));
      try {
        return await write(qc, () => api.post<{ deleted?: number; reset?: number }>(`/lists/${listId}/${action}`));
      } catch (e) {
        if (prev) qc.setQueryData(keys.detail(listId), prev);
        toast.error(errorMessage(e));
        return null;
      }
    },
    [qc],
  );

  const createList = useCallback(
    (body: { name: string; type: ListType; icon: string; color: string }) => write(qc, () => api.post<ListSummary>('/lists', body)),
    [qc],
  );
  const updateList = useCallback(
    (id: number, body: Partial<{ name: string; type: ListType; icon: string; color: string }>) =>
      write(qc, () => api.patch<ListDetail>(`/lists/${id}`, body)),
    [qc],
  );
  const deleteList = useCallback(
    async (id: number) => {
      await write(qc, async () => {
        await api.del(`/lists/${id}`);
        qc.setQueryData<ListSummary[]>(keys.lists, (l) => l?.filter((x) => x.id !== id));
        qc.removeQueries({ queryKey: keys.detail(id) });
      });
    },
    [qc],
  );
  const duplicateList = useCallback((id: number) => write(qc, () => api.post<ListDetail>(`/lists/${id}/duplicate`, {})), [qc]);
  const remind = useCallback(async (listId: number, itemId: number) => api.post(`/lists/${listId}/items/${itemId}/remind`), []);

  return { updateItem, addItem, deleteItem, reorder, bulkDone, createList, updateList, deleteList, duplicateList, remind };
}
