// Queries, cache helpers and realtime wiring for the messages module.
import { useEffect, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLive } from '../../lib/live';
import type { LiveEvent } from '../../lib/types';
import type {
  Conversation, Message, MessageEvent, MessagePage, ReadEvent, RemovedEvent, TypingEvent, UnreadSummary,
} from './types';

export const keys = {
  all: ['messages'] as const,
  conversations: ['messages', 'conversations'] as const,
  conversation: (id: number) => ['messages', 'conversation', id] as const,
  history: (id: number) => ['messages', 'history', id] as const,
  unread: ['messages', 'unread'] as const,
};

/* ------------------------------------------------------------------ queries */

export function useUnread() {
  const { familyId, user } = useAuth();
  return useQuery({
    queryKey: keys.unread,
    queryFn: () => api.get<UnreadSummary>('/messages/unread'),
    enabled: !!familyId && !!user,
    staleTime: 15_000,
  });
}

export function useConversations() {
  return useQuery({
    queryKey: keys.conversations,
    queryFn: () => api.get<Conversation[]>('/messages/conversations'),
  });
}

export function useConversation(id: number | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.conversation(id ?? 0),
    queryFn: () => api.get<Conversation>(`/messages/conversations/${id}`),
    enabled: !!id,
    retry: (count, err) => (err as { status?: number })?.status !== 404 && count < 2,
    // Show the list's copy instantly while the detail loads.
    placeholderData: () => qc.getQueryData<Conversation[]>(keys.conversations)?.find((c) => c.id === id),
  });
}

export function useHistory(id: number | null) {
  return useInfiniteQuery({
    queryKey: keys.history(id ?? 0),
    queryFn: ({ pageParam }) =>
      api.get<MessagePage>(`/messages/conversations/${id}/messages${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: 0 as number,
    // Pages go newest → oldest; "next" page = older messages.
    getNextPageParam: (last) => (last.has_more && last.messages.length ? last.messages[0].id : undefined),
    enabled: !!id,
    retry: (count, err) => (err as { status?: number })?.status !== 404 && count < 2,
  });
}

/** Flatten pages (newest page first) into ascending order. */
export const flatten = (data: InfiniteData<MessagePage> | undefined): Message[] =>
  data ? [...data.pages].reverse().flatMap((p) => p.messages) : [];

/* ------------------------------------------------------------ cache helpers */

type History = InfiniteData<MessagePage, number>;

/** Insert or replace a message in a conversation's cached history (dedupes by id / client_id). */
export function upsertMessage(qc: QueryClient, conversationId: number, message: Message, clientId?: string | null) {
  qc.setQueryData<History>(keys.history(conversationId), (data) => {
    if (!data) return data;
    let found = false;
    const pages = data.pages.map((p) => ({
      ...p,
      messages: p.messages.map((m) => {
        if (m.id === message.id || (clientId && m.client_id === clientId && m.pending !== undefined)) {
          found = true;
          return { ...message, client_id: clientId ?? m.client_id ?? null };
        }
        return m;
      }),
    }));
    if (!found) {
      // Remove any duplicate that might exist then append to the newest page.
      const first = pages[0];
      pages[0] = { ...first, messages: [...first.messages, { ...message, client_id: clientId ?? null }].sort(byTime) };
    } else {
      // A pending message replaced by the server copy might now duplicate an SSE-inserted one.
      const seen = new Set<number>();
      for (const p of pages) {
        p.messages = p.messages.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      }
    }
    return { ...data, pages };
  });
}

// Pending messages (negative ids) always sort after real ones.
const byTime = (a: Message, b: Message) => {
  if (a.id < 0 && b.id > 0) return 1;
  if (b.id < 0 && a.id > 0) return -1;
  return a.id > 0 && b.id > 0 ? a.id - b.id : a.created_at.localeCompare(b.created_at);
};

export function patchMessage(qc: QueryClient, conversationId: number, id: number, patch: (m: Message) => Message) {
  qc.setQueryData<History>(keys.history(conversationId), (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, messages: p.messages.map((m) => (m.id === id ? patch(m) : m)) })) } : data,
  );
}

export function removeMessage(qc: QueryClient, conversationId: number, id: number) {
  qc.setQueryData<History>(keys.history(conversationId), (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, messages: p.messages.filter((m) => m.id !== id) })) } : data,
  );
}

/**
 * Patch the cached conversation list from a message payload (preview, time, unread, order) instead
 * of refetching it. Returns false when the conversation isn't cached (caller should refetch).
 */
export function patchListWithMessage(qc: QueryClient, conversationId: number, message: Message, meId: number | undefined, updated = false): boolean {
  const list = qc.getQueryData<Conversation[]>(keys.conversations);
  if (!list) return true;
  const idx = list.findIndex((c) => c.id === conversationId);
  if (idx < 0) return false;
  const c = list[idx];
  const preview = {
    id: message.id,
    user_id: message.user_id,
    kind: message.kind,
    body: message.deleted ? '' : message.body.replace(/\s+/g, ' ').slice(0, 140),
    deleted: message.deleted,
    attachments: message.attachments.length,
    created_at: message.created_at,
  };
  let next: Conversation;
  if (updated) {
    if (c.last_message?.id !== message.id) return true;
    next = { ...c, last_message: preview };
  } else {
    if (c.last_message && c.last_message.id >= message.id) return true;
    const mine = message.user_id === meId;
    next = {
      ...c,
      last_message: preview,
      last_activity_at: message.created_at,
      unread: mine || message.kind !== 'text' ? c.unread : c.unread + 1,
      last_read_id: mine ? message.id : c.last_read_id,
    };
  }
  const rest = list.filter((_, i) => i !== idx);
  qc.setQueryData<Conversation[]>(keys.conversations, updated ? list.map((x, i) => (i === idx ? next : x)) : [next, ...rest]);
  return true;
}

/** Optimistically mark a conversation read in the list + unread caches. */
export function markReadLocally(qc: QueryClient, conversationId: number, lastReadId: number) {
  qc.setQueryData<Conversation[]>(keys.conversations, (list) =>
    list?.map((c) => (c.id === conversationId ? { ...c, unread: 0, last_read_id: Math.max(c.last_read_id, lastReadId) } : c)),
  );
  qc.setQueryData<UnreadSummary>(keys.unread, (u) => {
    if (!u) return u;
    const n = u.conversations[conversationId] ?? 0;
    if (!n) return u;
    const conv = qc.getQueryData<Conversation[]>(keys.conversations)?.find((c) => c.id === conversationId);
    const conversations = { ...u.conversations };
    delete conversations[conversationId];
    return conv?.muted
      ? { ...u, muted_total: Math.max(0, u.muted_total - n), conversations }
      : { ...u, total: Math.max(0, u.total - n), conversations };
  });
}

/* ----------------------------------------------------------- typing store */

type TypingMap = Map<number, Map<number, { name: string; until: number }>>;
let typing: TypingMap = new Map();
const typingSubs = new Set<() => void>();
const emitTyping = () => typingSubs.forEach((s) => s());
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function setTyping(convId: number, userId: number, name: string | null) {
  const next: TypingMap = new Map(typing);
  const inner = new Map(next.get(convId) ?? []);
  if (name) inner.set(userId, { name, until: Date.now() + 6000 });
  else inner.delete(userId);
  if (inner.size) next.set(convId, inner);
  else next.delete(convId);
  typing = next;
  emitTyping();
  if (!sweepTimer && typing.size) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      const swept: TypingMap = new Map();
      for (const [c, m] of typing) {
        const kept = new Map([...m].filter(([, v]) => v.until > now));
        if (kept.size !== m.size) changed = true;
        if (kept.size) swept.set(c, kept);
      }
      if (changed) {
        typing = swept;
        emitTyping();
      }
      if (!typing.size && sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    }, 1000);
  }
}

/** Names of people typing in a conversation (or across all when id is null → map). */
export function useTyping(): TypingMap {
  return useSyncExternalStore(
    (cb) => {
      typingSubs.add(cb);
      return () => typingSubs.delete(cb);
    },
    () => typing,
    () => typing,
  );
}

export function typingNames(map: TypingMap, convId: number): string[] {
  return [...(map.get(convId)?.values() ?? [])].map((v) => v.name.split(/\s+/)[0]);
}

export function typingLabel(names: string[]): string {
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

/* ---------------------------------------------------------------- realtime */

const COUNT_EVENTS = new Set([
  'messages.message.created', 'messages.message.updated', 'messages.read',
  'messages.conversation.created', 'messages.conversation.updated', 'messages.conversation.removed',
]);

/** Nav badge: keeps ['messages','unread'] fresh (no side effects besides cache invalidation). */
export function useUnreadBadge(): number | undefined {
  const qc = useQueryClient();
  const { data } = useUnread();
  useLive(
    'messages',
    (e) => {
      if (COUNT_EVENTS.has(e.type)) void qc.invalidateQueries({ queryKey: keys.unread });
    },
    { invalidate: false },
  );
  return data?.total;
}

/**
 * Page-level realtime handler: patches caches for instant updates, tracks typing, and reports
 * conversation removal so the page can navigate away.
 */
export function useMessagesLive({ meId, onRemoved }: { meId: number | undefined; onRemoved: (e: RemovedEvent) => void }) {
  const qc = useQueryClient();
  useLive(
    'messages',
    (e: LiveEvent<unknown>) => {
      switch (e.type) {
        case 'messages.typing': {
          const p = e.payload as TypingEvent;
          if (p.user_id !== meId) setTyping(p.conversation_id, p.user_id, p.name);
          return;
        }
        case 'messages.message.created': {
          const p = e.payload as MessageEvent;
          if (p.message.user_id) setTyping(p.conversation_id, p.message.user_id, null);
          upsertMessage(qc, p.conversation_id, p.message, p.client_id);
          if (!patchListWithMessage(qc, p.conversation_id, p.message, meId)) void qc.invalidateQueries({ queryKey: keys.conversations });
          return;
        }
        case 'messages.message.updated': {
          const p = e.payload as MessageEvent;
          patchMessage(qc, p.conversation_id, p.message.id, (m) => ({ ...p.message, client_id: m.client_id }));
          if (!patchListWithMessage(qc, p.conversation_id, p.message, meId, true)) void qc.invalidateQueries({ queryKey: keys.conversations });
          return;
        }
        case 'messages.read': {
          const p = e.payload as ReadEvent;
          const patch = (c: Conversation): Conversation => ({
            ...c,
            participants: c.participants.map((u) => (u.id === p.user_id ? { ...u, last_read_id: Math.max(u.last_read_id, p.last_read_id) } : u)),
          });
          qc.setQueryData<Conversation>(keys.conversation(p.conversation_id), (c) => (c ? patch(c) : c));
          qc.setQueryData<Conversation[]>(keys.conversations, (list) => list?.map((c) => (c.id === p.conversation_id ? patch(c) : c)));
          if (p.user_id === meId) {
            // Read on another device/tab.
            void qc.invalidateQueries({ queryKey: keys.conversations });
          }
          return;
        }
        case 'messages.conversation.created':
        case 'messages.conversation.updated': {
          const c = e.payload as Conversation;
          qc.setQueryData<Conversation>(keys.conversation(c.id), (old) => (old ? { ...old, ...c } : old));
          void qc.invalidateQueries({ queryKey: keys.conversations });
          return;
        }
        case 'messages.conversation.removed': {
          const p = e.payload as RemovedEvent;
          qc.setQueryData<Conversation[]>(keys.conversations, (list) => list?.filter((c) => c.id !== p.conversation_id));
          qc.removeQueries({ queryKey: keys.history(p.conversation_id) });
          void qc.invalidateQueries({ queryKey: keys.conversations });
          onRemoved(p);
          return;
        }
        default:
      }
    },
    { invalidate: false },
  );
}

/** Throttled "I'm typing" pings for a conversation. */
export function useTypingPing(conversationId: number | null) {
  useEffect(() => {
    lastPing = 0;
  }, [conversationId]);
  return () => {
    if (!conversationId) return;
    const now = Date.now();
    if (now - lastPing < 3000) return;
    lastPing = now;
    api.post(`/messages/conversations/${conversationId}/typing`).catch(() => {});
  };
}
let lastPing = 0;
