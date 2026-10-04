import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, CheckCheck, BellOff, Copy, CornerUpLeft, Info, MessageCircleOff, Pencil, SmilePlus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDateTime } from '../../lib/format';
import { useMediaQuery } from '../../lib/hooks';
import { Avatar, Button, EmptyState, IconButton, Lightbox, Modal, Skeleton, toast, useConfirm } from '../../ui';
import { Composer, type OutgoingFile } from './Composer';
import { EmojiPicker } from './EmojiPicker';
import { MessageBubble, type GroupPos } from './MessageBubble';
import {
  flatten, keys, markReadLocally, patchListWithMessage, patchMessage, removeMessage, typingLabel, typingNames, upsertMessage, useConversation,
  useHistory, useTyping, useTypingPing,
} from './data';
import { knownPeople } from './parts';
import { ACCENT, ConversationAvatar, QUICK_REACTIONS, TypingDots, conversationSubtitle, dayLabel, joinNames, shortName } from './parts';
import type { Conversation, Message } from './types';

const GROUP_GAP_MS = 5 * 60_000;
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

type Row =
  | { type: 'day'; key: string; label: string }
  | { type: 'unread'; key: string }
  | { type: 'msg'; key: string; message: Message; pos: GroupPos };

function buildRows(messages: Message[], unreadAfter: number | null, meId: number): Row[] {
  const rows: Row[] = [];
  const firstUnread = unreadAfter == null ? -1 : messages.findIndex((m) => m.id > unreadAfter && m.user_id !== meId && m.kind === 'text' && m.id > 0);
  const groupable = (a: Message | undefined, b: Message | undefined, iB: number) =>
    !!a && !!b && a.kind === 'text' && b.kind === 'text' && a.user_id === b.user_id && sameDay(a.created_at, b.created_at) &&
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime() < GROUP_GAP_MS && iB !== firstUnread;
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (!prev || !sameDay(prev.created_at, m.created_at)) rows.push({ type: 'day', key: `d${m.created_at.slice(0, 10)}-${m.id}`, label: dayLabel(m.created_at) });
    if (i === firstUnread) rows.push({ type: 'unread', key: 'unread' });
    const joinPrev = groupable(prev, m, i) && (!prev || sameDay(prev.created_at, m.created_at));
    const joinNext = groupable(m, next, i + 1);
    const pos: GroupPos = joinPrev ? (joinNext ? 'middle' : 'last') : joinNext ? 'first' : 'single';
    rows.push({ type: 'msg', key: m.client_id ? `c-${m.client_id}` : `m${m.id}`, message: m, pos });
  });
  return rows;
}

export function ChatView({ conversationId, onInfo, infoOpen }: { conversationId: number; onInfo: () => void; infoOpen: boolean }) {
  const { user, role, members } = useAuth();
  const meId = user!.id;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const touch = useMediaQuery('(hover: none)');
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [params, setParams] = useSearchParams();
  const convQ = useConversation(conversationId);
  const hist = useHistory(conversationId);
  const conv = convQ.data;
  const messages = useMemo(() => flatten(hist.data), [hist.data]);
  const typingMap = useTyping();
  const typers = typingNames(typingMap, conversationId);
  const ping = useTypingPing(conversationId);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [sheet, setSheet] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<{ message: Message; index: number } | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const retries = useRef(new Map<string, { body: string; files: OutgoingFile[]; replyToId: number | null }>());

  // Snapshot of where I had read up to when opening the conversation (for the "New messages" divider).
  const [unreadAfter, setUnreadAfter] = useState<number | null>(null);
  const snapFor = useRef<number | null>(null);
  useEffect(() => {
    if (conv && snapFor.current !== conversationId) {
      snapFor.current = conversationId;
      setUnreadAfter(conv.unread > 0 ? conv.last_read_id : null);
    }
  }, [conv, conversationId]);
  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    setNewCount(0);
  }, [conversationId]);

  const rows = useMemo(() => buildRows(messages, unreadAfter, meId), [messages, unreadAfter, meId]);
  const participants = useMemo(() => conv?.participants ?? [], [conv]);
  // Authors: participants, falling back to family members who left this conversation.
  const people = useMemo(() => knownPeople(participants, members), [participants, members]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  /* ---------------------------------------------------------- scrolling */
  const scroller = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const prevEdge = useRef<{ first: number | null; last: number | null; height: number; top: number; conv: number }>({ first: null, last: null, height: 0, top: 0, conv: 0 });
  const initialScrollDone = useRef<number | null>(null);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages.length) return;
    const first = messages[0].id;
    const last = messages[messages.length - 1];
    const prev = prevEdge.current;
    if (initialScrollDone.current !== conversationId) {
      initialScrollDone.current = conversationId;
      const divider = el.querySelector('[data-unread-divider]') as HTMLElement | null;
      if (divider && !params.get('m')) el.scrollTop = divider.offsetTop - 80;
      else el.scrollTop = el.scrollHeight;
    } else if (prev.conv === conversationId) {
      if (prev.first !== null && first !== prev.first && last.id === prev.last) {
        // Older page prepended: keep the viewport anchored.
        el.scrollTop = prev.top + (el.scrollHeight - prev.height);
      } else if (last.id !== prev.last) {
        const nearBottom = prev.height - prev.top - el.clientHeight < 120;
        if (last.user_id === meId || nearBottom) requestAnimationFrame(() => scrollToBottom(true));
        else if (last.user_id !== meId && last.kind === 'text') setNewCount((n) => n + 1);
      }
    }
    prevEdge.current = { first, last: last.id, height: el.scrollHeight, top: el.scrollTop, conv: conversationId };
  }, [messages, conversationId, meId, scrollToBottom, params]);

  const [floatDay, setFloatDay] = useState<{ label: string; visible: boolean }>({ label: '', visible: false });
  const floatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUserInput = useRef(0);
  const markUserInput = () => {
    lastUserInput.current = Date.now();
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // Floating day chip: label of the last day separator above the viewport top; fades when idle.
    // Only for user-driven scrolling, and only once that day's own separator is out of view.
    let label = '';
    if (Date.now() - lastUserInput.current < 1500) {
      for (const sep of el.querySelectorAll<HTMLElement>('[data-day-label]')) {
        if (sep.offsetTop + sep.offsetHeight <= el.scrollTop) label = sep.dataset.dayLabel ?? '';
        else break;
      }
    }
    if (label) {
      setFloatDay({ label, visible: true });
      if (floatTimer.current) clearTimeout(floatTimer.current);
      floatTimer.current = setTimeout(() => setFloatDay((d) => ({ ...d, visible: false })), 1200);
    } else setFloatDay((d) => (d.visible ? { ...d, visible: false } : d));
    prevEdge.current.height = el.scrollHeight;
    prevEdge.current.top = el.scrollTop;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    if (bottom) {
      setNewCount(0);
      tryMarkRead();
    }
  };

  // Load older messages when the top sentinel becomes visible.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = hist;
  useEffect(() => {
    const el = topSentinel.current;
    const root = scroller.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage && initialScrollDone.current === conversationId) void fetchNextPage();
      },
      { root, rootMargin: '240px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, conversationId, messages.length]);

  // Keep pinned to the bottom when the typing bubble appears.
  useEffect(() => {
    if (typers.length && atBottom) scrollToBottom(true);
  }, [typers.length, atBottom, scrollToBottom]);

  /* ---------------------------------------------------------- jump to message */
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);
  const jumpTries = useRef(0);
  const paramTarget = Number(params.get('m')) || null;
  useEffect(() => {
    if (paramTarget) {
      setJumpTarget(paramTarget);
      jumpTries.current = 0;
    }
  }, [paramTarget, conversationId]);
  useEffect(() => {
    if (!jumpTarget || !hist.data) return;
    const el = scroller.current?.querySelector(`[data-message-id="${jumpTarget}"]`) as HTMLElement | null;
    const clearParam = () => {
      if (params.get('m')) {
        const next = new URLSearchParams(params);
        next.delete('m');
        setParams(next, { replace: true });
      }
    };
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: jumpTries.current ? 'auto' : 'smooth' });
      setHighlight(jumpTarget);
      setJumpTarget(null);
      clearParam();
      const t = setTimeout(() => setHighlight(null), 2200);
      return () => clearTimeout(t);
    }
    if (hasNextPage && !isFetchingNextPage && jumpTries.current < 25) {
      jumpTries.current++;
      void fetchNextPage();
    } else if (!hasNextPage && !isFetchingNextPage) {
      setJumpTarget(null);
      clearParam();
      toast.info('That message is no longer available');
    }
  }, [jumpTarget, hist.data, hasNextPage, isFetchingNextPage, fetchNextPage, params, setParams]);

  /* ---------------------------------------------------------- read receipts */
  const latestReal = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].id > 0) return messages[i].id;
    return 0;
  }, [messages]);
  const myRead = participants.find((p) => p.id === meId)?.last_read_id ?? conv?.last_read_id ?? 0;
  const readSent = useRef(0);
  const readState = useRef({ latestReal, myRead, conversationId });
  readState.current = { latestReal, myRead, conversationId };
  /** Mark everything up to the latest message read when the viewer is at the bottom of a visible tab. */
  const tryMarkRead = useCallback(() => {
    const { latestReal: latest, myRead: read, conversationId: cid } = readState.current;
    const el = scroller.current;
    if (!el || !latest || latest <= Math.max(read, readSent.current)) return;
    if (document.visibilityState !== 'visible') return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 150) return;
    readSent.current = latest;
    markReadLocally(qc, cid, latest);
    api.post(`/messages/conversations/${cid}/read`, { last_read_id: latest }).catch(() => {
      readSent.current = 0;
    });
  }, [qc]);
  useEffect(() => {
    // Twice: once soon, once after any smooth scroll to the new message has finished.
    const t1 = setTimeout(tryMarkRead, 300);
    const t2 = setTimeout(tryMarkRead, 1200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [latestReal, atBottom, myRead, conversationId, tryMarkRead]);
  useEffect(() => {
    readSent.current = 0;
  }, [conversationId]);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') tryMarkRead();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [tryMarkRead]);

  const lastOwn = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.user_id === meId && m.kind === 'text' && m.id > 0 && !m.deleted) return m;
    }
    return null;
  }, [messages, meId]);
  const seenBy = lastOwn ? participants.filter((p) => p.id !== meId && !p.managed && p.last_read_id >= lastOwn.id) : [];
  const possibleReaders = participants.filter((p) => p.id !== meId && !p.managed);

  /* ---------------------------------------------------------- actions */
  const send = useCallback(
    async (body: string, files: OutgoingFile[], replyToId: number | null, reuseClientId?: string) => {
      const clientId = reuseClientId ?? newClientId();
      const temp: Message = {
        id: -Date.now(),
        conversation_id: conversationId,
        user_id: meId,
        kind: 'text',
        body,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted: false,
        reply_to: replyToId
          ? (() => {
              const r = messages.find((m) => m.id === replyToId);
              return r ? { id: r.id, user_id: r.user_id, body: r.body, deleted: r.deleted, attachments: r.attachments.length } : null;
            })()
          : null,
        attachments: files.map((f, i) => ({ id: -(i + 1), url: f.preview, mime: f.file.type, width: f.width, height: f.height, size: f.file.size, local: true })),
        reactions: [],
        client_id: clientId,
        pending: true,
      };
      removeFailed(clientId);
      upsertMessage(qc, conversationId, temp, clientId);
      setUnreadAfter(null);
      retries.current.set(clientId, { body, files, replyToId });
      try {
        let saved: Message;
        if (files.length) {
          const fd = new FormData();
          fd.append('body', body);
          fd.append('client_id', clientId);
          if (replyToId) fd.append('reply_to_id', String(replyToId));
          fd.append('dims', JSON.stringify(files.map((f) => [f.width, f.height])));
          for (const f of files) fd.append('files', f.file, f.file.name);
          saved = await api.upload<Message>(`/messages/conversations/${conversationId}/messages`, fd);
        } else {
          saved = await api.post<Message>(`/messages/conversations/${conversationId}/messages`, { body, reply_to_id: replyToId, client_id: clientId });
        }
        retries.current.delete(clientId);
        upsertMessage(qc, conversationId, { ...saved, pending: undefined }, clientId);
        patchListWithMessage(qc, conversationId, saved, meId);
      } catch {
        // The bubble shows an inline "Not sent · Retry · Discard" instead of a toast over the composer.
        patchMessageByClient(clientId, (m) => ({ ...m, pending: false, failed: true }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, meId, messages, qc],
  );

  function patchMessageByClient(clientId: string, fn: (m: Message) => Message) {
    const data = qc.getQueryData<{ pages: { messages: Message[] }[] }>(keys.history(conversationId));
    const m = data?.pages.flatMap((p) => p.messages).find((x) => x.client_id === clientId);
    if (m) patchMessage(qc, conversationId, m.id, fn);
  }
  function removeFailed(clientId: string) {
    const data = qc.getQueryData<{ pages: { messages: Message[] }[] }>(keys.history(conversationId));
    const m = data?.pages.flatMap((p) => p.messages).find((x) => x.client_id === clientId && x.failed);
    if (m) removeMessage(qc, conversationId, m.id);
  }

  const onRetry = useCallback(
    (m: Message) => {
      const r = m.client_id ? retries.current.get(m.client_id) : null;
      if (!r || !m.client_id) return;
      void send(r.body, r.files, r.replyToId, m.client_id);
    },
    [send],
  );
  const onDiscard = useCallback(
    (m: Message) => {
      if (m.client_id) retries.current.delete(m.client_id);
      removeMessage(qc, conversationId, m.id);
    },
    [qc, conversationId],
  );

  const onReact = useCallback(
    async (m: Message, emoji: string) => {
      setSheet(null);
      const toggle = (msg: Message): Message => {
        const has = msg.reactions.find((r) => r.emoji === emoji)?.user_ids.includes(meId);
        let reactions = msg.reactions.map((r) =>
          r.emoji === emoji ? { ...r, user_ids: has ? r.user_ids.filter((u) => u !== meId) : [...r.user_ids, meId] } : r,
        );
        if (!msg.reactions.some((r) => r.emoji === emoji)) reactions = [...reactions, { emoji, user_ids: [meId] }];
        return { ...msg, reactions: reactions.filter((r) => r.user_ids.length) };
      };
      patchMessage(qc, conversationId, m.id, toggle);
      try {
        const saved = await api.post<Message>(`/messages/messages/${m.id}/reactions`, { emoji });
        patchMessage(qc, conversationId, m.id, (old) => ({ ...saved, client_id: old.client_id }));
      } catch (e) {
        patchMessage(qc, conversationId, m.id, toggle);
        toast.error(errorMessage(e));
      }
    },
    [qc, conversationId, meId],
  );

  const onDelete = useCallback(
    async (m: Message) => {
      setSheet(null);
      const own = m.user_id === meId;
      const ok = await confirm({
        title: own ? 'Delete this message?' : 'Delete this message for everyone?',
        message: own ? 'It will be removed for everyone in this conversation.' : `As a family admin you can remove ${shortName(byId.get(m.user_id ?? 0))}'s message for everyone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        const saved = await api.del<Message>(`/messages/messages/${m.id}`);
        patchMessage(qc, conversationId, m.id, (old) => ({ ...saved, client_id: old.client_id }));
        if (replyTo?.id === m.id) setReplyTo(null);
        if (editing?.id === m.id) setEditing(null);
        void qc.invalidateQueries({ queryKey: keys.conversations });
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    [confirm, meId, byId, qc, conversationId, replyTo, editing],
  );

  const onSaveEdit = useCallback(
    async (m: Message, body: string) => {
      setEditing(null);
      if (body === m.body) return;
      patchMessage(qc, conversationId, m.id, (old) => ({ ...old, body, edited_at: new Date().toISOString() }));
      try {
        const saved = await api.patch<Message>(`/messages/messages/${m.id}`, { body });
        patchMessage(qc, conversationId, m.id, (old) => ({ ...saved, client_id: old.client_id }));
      } catch (e) {
        patchMessage(qc, conversationId, m.id, (old) => ({ ...old, body: m.body, edited_at: m.edited_at }));
        toast.error(errorMessage(e));
      }
    },
    [qc, conversationId],
  );

  const onCopy = useCallback(async (m: Message) => {
    setSheet(null);
    try {
      await navigator.clipboard.writeText(m.body);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy');
    }
  }, []);

  const onReply = useCallback((m: Message) => {
    setSheet(null);
    setEditing(null);
    setReplyTo(m);
  }, []);
  const onEdit = useCallback((m: Message) => {
    setSheet(null);
    setReplyTo(null);
    setEditing(m);
  }, []);
  const onOpenImage = useCallback((m: Message, index: number) => setLightbox({ message: m, index }), []);
  const onJumpTo = useCallback((id: number) => {
    jumpTries.current = 0;
    setJumpTarget(id);
  }, []);

  // ArrowUp in an empty composer edits my last message.
  useEffect(() => {
    const root = sectionRef.current;
    if (!root) return;
    const handler = () => {
      if (lastOwn && lastOwn.body) onEdit(lastOwn);
    };
    root.addEventListener('hearth:edit-last', handler);
    return () => root.removeEventListener('hearth:edit-last', handler);
  }, [lastOwn, onEdit]);

  /* ---------------------------------------------------------- render */
  const notFound = (convQ.isError && (convQ.error as { status?: number })?.status === 404) || (hist.isError && (hist.error as { status?: number })?.status === 404);
  if (notFound) {
    return (
      <div className="flex h-full flex-col">
        {!isDesktop && <BackBar />}
        <EmptyState
          className="flex-1"
          icon={MessageCircleOff}
          accent={ACCENT}
          title="Conversation not found"
          description="It may have been deleted, or you're no longer part of it."
          action={<Link to="/messages" className="font-semibold text-primary hover:underline">Back to messages</Link>}
        />
      </div>
    );
  }

  const directOther = conv?.kind === 'direct' ? conv.participants.find((p) => p.id !== meId) : null;
  const cannotSend = conv?.kind === 'direct' && !directOther;
  const lightboxImages = lightbox
    ? lightbox.message.attachments.map((a) => ({
        src: a.url,
        caption: (
          <span>
            <strong className="font-semibold">{lightbox.message.user_id === meId ? 'You' : byId.get(lightbox.message.user_id ?? 0)?.name ?? 'Someone'}</strong>
            <span className="text-white/60"> · {fmtDateTime(lightbox.message.created_at)}</span>
            {lightbox.message.body && <span className="mt-1 block text-white/85">{lightbox.message.body}</span>}
          </span>
        ),
      }))
    : [];

  return (
    <section ref={sectionRef} aria-label={conv ? `Conversation: ${conv.title}` : 'Conversation'} className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-2 py-2 backdrop-blur sm:gap-3 sm:px-4 sm:py-2.5">
        {!isDesktop && (
          <Link to="/messages" aria-label="Back to conversations" className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg">
            <ArrowLeft size={21} />
          </Link>
        )}
        {conv ? (
          <button type="button" onClick={onInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-0.5 pr-2 text-left transition hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring" aria-label={`${conv.title} — conversation details`}>
            <ConversationAvatar conv={conv} meId={meId} size={40} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[16px] font-bold tracking-tight text-fg">{conv.kind === 'group' && conv.emoji ? conv.title : conv.title}</span>
                {conv.muted && <BellOff size={14} className="shrink-0 text-subtle" aria-label="Muted" />}
              </span>
              <span className={cn('block truncate text-[12.5px]', typers.length ? 'font-medium text-primary' : 'text-muted')}>
                {typers.length ? typingLabel(typers) : conversationSubtitle(conv, meId)}
              </span>
            </span>
          </button>
        ) : (
          <div className="flex flex-1 items-center gap-3">
            <Skeleton circle className="size-10" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        )}
        <IconButton icon={Info} label={infoOpen ? 'Hide details' : 'Conversation details'} onClick={onInfo} variant={infoOpen ? 'soft' : 'ghost'} aria-pressed={infoOpen} />
      </header>

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          onWheel={markUserInput}
          onTouchMove={markUserInput}
          onPointerDown={markUserInput}
          onKeyDown={markUserInput}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Messages"
          tabIndex={0}
          className={cn(
            'h-full overflow-y-auto overscroll-contain px-2.5 pt-3 scrollbar-thin transition-[padding] focus-visible:outline-none sm:px-5',
            // Leave room under the last message for the "Latest" pill so it never covers content.
            (!atBottom || newCount > 0) && messages.length > 0 ? 'pb-16' : 'pb-2',
          )}
          style={{ backgroundImage: `radial-gradient(circle at 20% 0%, color-mix(in oklab, ${ACCENT} 5%, transparent), transparent 45%)` }}
        >
          <div ref={topSentinel} className="h-px" aria-hidden />
          {hist.isPending ? (
            <ChatSkeleton />
          ) : hist.isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted">
              Couldn't load messages.
              <Button size="sm" variant="secondary" onClick={() => hist.refetch()}>Try again</Button>
            </div>
          ) : messages.length === 0 ? (
            <EmptyChat conv={conv} meId={meId} onWave={() => send('👋', [], null)} />
          ) : (
            <>
              {isFetchingNextPage && (
                <div className="flex justify-center py-3" role="status" aria-label="Loading older messages">
                  <span className="size-5 animate-spin rounded-full border-2 border-border border-t-primary" />
                </div>
              )}
              {!hasNextPage && conv && (
                <div className="mb-4 mt-2 flex flex-col items-center gap-2 text-center">
                  <ConversationAvatar conv={conv} meId={meId} size={56} />
                  <p className="text-sm font-semibold text-fg">{conv.title}</p>
                  <p className="max-w-xs text-xs text-muted">
                    {conv.kind === 'family'
                      ? 'The whole family is here. Messages are private to your family.'
                      : conv.kind === 'direct'
                        ? `This is the beginning of your conversation with ${directOther ? shortName(directOther) : 'a former member'}.`
                        : `Group started ${fmtDateTime(conv.created_at)}.`}
                  </p>
                </div>
              )}
              {rows.map((row) => {
                if (row.type === 'day') {
                  return (
                    <div key={row.key} data-day-label={row.label} className="flex justify-center py-2">
                      <span className="rounded-full border border-border bg-surface/90 px-3 py-1 text-[11.5px] font-semibold text-muted shadow-xs backdrop-blur">{row.label}</span>
                    </div>
                  );
                }
                if (row.type === 'unread') {
                  return (
                    <div key={row.key} data-unread-divider className="my-3 flex items-center gap-3" role="separator" aria-label="New messages">
                      <span className="h-px flex-1 bg-danger/40" />
                      <span className="text-[11.5px] font-bold uppercase tracking-wide text-danger">New messages</span>
                      <span className="h-px flex-1 bg-danger/40" />
                    </div>
                  );
                }
                const m = row.message;
                const own = m.user_id === meId;
                return (
                  <Fragment key={row.key}>
                    <MessageBubble
                      message={m}
                      own={own}
                      author={m.user_id ? byId.get(m.user_id) : undefined}
                      participants={people}
                      meId={meId}
                      pos={row.pos}
                      showName={conv?.kind !== 'direct'}
                      canDelete={own || role === 'admin'}
                      touch={touch}
                      highlighted={highlight === m.id}
                      onReply={onReply}
                      onReact={onReact}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      onCopy={onCopy}
                      onRetry={onRetry}
                      onDiscard={onDiscard}
                      onOpenImage={onOpenImage}
                      onJumpTo={onJumpTo}
                      onActions={setSheet}
                    />
                    {lastOwn && m.id === lastOwn.id && seenBy.length > 0 && (
                      <div className="-mt-1 mb-2 flex items-center justify-end gap-1.5 pr-2 text-[11px] text-subtle animate-fade-in" aria-label={`Seen by ${seenBy.map((p) => p.name).join(', ')}`}>
                        <CheckCheck size={13} className="text-primary" aria-hidden />
                        <span>
                          {conv?.kind === 'direct'
                            ? 'Seen'
                            : seenBy.length === possibleReaders.length && possibleReaders.length > 1
                              ? 'Seen by everyone'
                              : `Seen by ${joinNames(seenBy.map(shortName))}`}
                        </span>
                      </div>
                    )}
                  </Fragment>
                );
              })}
              {typers.length > 0 && (
                <div className="mb-2 flex items-end gap-2 animate-fade-in" aria-live="off">
                  <div className="w-8 shrink-0">
                    <Avatar user={participants.find((p) => shortName(p) === typers[0]) ?? { name: typers[0] }} size="sm" />
                  </div>
                  <div className="rounded-[20px] rounded-bl-md bg-surface px-4 py-3 text-muted ring-1 ring-inset ring-border dark:bg-surface-2">
                    <TypingDots />
                    <span className="sr-only">{typingLabel(typers)}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface/95 px-3 py-1 text-[11.5px] font-semibold text-muted shadow-card backdrop-blur transition-opacity duration-300',
            floatDay.visible ? 'opacity-100' : 'opacity-0',
          )}
        >
          {floatDay.label}
        </div>
        {(!atBottom || newCount > 0) && messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              scrollToBottom(true);
              setNewCount(0);
            }}
            className="absolute bottom-3 right-3 z-10 inline-flex size-11 items-center justify-center rounded-full border border-border bg-surface text-fg shadow-lift transition hover:bg-surface-2 animate-pop-in focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring sm:right-5"
            aria-label={newCount ? `${newCount} new ${newCount === 1 ? 'message' : 'messages'}, jump to latest` : 'Jump to latest'}
            title="Jump to latest"
          >
            <ArrowDown size={19} aria-hidden />
            {newCount > 0 && (
              <span aria-hidden className="absolute -left-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-solid px-1.5 text-[11px] font-bold tabular-nums text-white ring-2 ring-surface">
                {newCount > 99 ? '99+' : newCount}
              </span>
            )}
          </button>
        )}
      </div>

      <Composer
        conversationKey={conversationId}
        replyTo={replyTo}
        replyAuthor={replyTo ? (replyTo.user_id === meId ? 'yourself' : shortName(byId.get(replyTo.user_id ?? 0))) : ''}
        editing={editing}
        participants={participants}
        meId={meId}
        disabled={cannotSend}
        disabledReason="This person is no longer in the family."
        onCancelReply={() => setReplyTo(null)}
        onCancelEdit={() => setEditing(null)}
        onSend={(body, files) => {
          const r = replyTo?.id ?? null;
          setReplyTo(null);
          void send(body, files, r);
        }}
        onSaveEdit={onSaveEdit}
        onTyping={ping}
      />

      {/* Touch action sheet */}
      <Modal open={!!sheet} onClose={() => setSheet(null)} title="Message" size="sm">
        {sheet && (
          <div className="space-y-4">
            <p className="line-clamp-3 rounded-2xl bg-surface-2 px-3.5 py-2.5 text-sm text-muted">{sheet.body || '📷 Photo'}</p>
            <div className="flex items-center justify-between gap-1" role="group" aria-label="React">
              {QUICK_REACTIONS.map((e) => {
                const mine = sheet.reactions.find((r) => r.emoji === e)?.user_ids.includes(meId);
                return (
                  <button
                    key={e}
                    type="button"
                    aria-label={`React ${e}`}
                    aria-pressed={!!mine}
                    onClick={() => onReact(sheet, e)}
                    className={cn('flex size-11 items-center justify-center rounded-full text-[24px] transition active:scale-90', mine ? 'bg-primary-soft' : 'bg-surface-2')}
                  >
                    {e}
                  </button>
                );
              })}
              <EmojiPicker
                label="More reactions"
                onPick={(e) => onReact(sheet, e)}
                trigger={(t) => (
                  <button type="button" {...t} aria-label="More reactions" className="flex size-11 items-center justify-center rounded-full bg-surface-2 text-muted">
                    <SmilePlus size={20} />
                  </button>
                )}
              />
            </div>
            <div className="overflow-hidden rounded-2xl border border-border">
              <SheetAction icon={CornerUpLeft} label="Reply" onClick={() => onReply(sheet)} />
              {sheet.body && <SheetAction icon={Copy} label="Copy text" onClick={() => onCopy(sheet)} />}
              {sheet.user_id === meId && sheet.body && <SheetAction icon={Pencil} label="Edit" onClick={() => onEdit(sheet)} />}
              {(sheet.user_id === meId || role === 'admin') && <SheetAction icon={Trash2} label="Delete" danger onClick={() => onDelete(sheet)} />}
            </div>
          </div>
        )}
      </Modal>

      <Lightbox
        images={lightboxImages}
        index={lightbox ? lightbox.index : null}
        onClose={() => setLightbox(null)}
        onIndexChange={(i) => setLightbox((l) => (l ? { ...l, index: i } : l))}
      />
    </section>
  );
}

function SheetAction({ icon: Icon, label, onClick, danger }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex w-full items-center gap-3 border-b border-border px-4 py-3.5 text-left text-[15px] font-medium last:border-0 active:bg-surface-2', danger ? 'text-danger' : 'text-fg')}
    >
      <Icon size={19} className={danger ? '' : 'text-muted'} /> {label}
    </button>
  );
}

function BackBar() {
  return (
    <div className="flex items-center border-b border-border px-2 py-2">
      <Link to="/messages" aria-label="Back to conversations" className="inline-flex size-10 items-center justify-center rounded-xl text-muted hover:bg-surface-2">
        <ArrowLeft size={21} />
      </Link>
    </div>
  );
}

function EmptyChat({ conv, meId, onWave }: { conv: Conversation | undefined; meId: number; onWave: () => void }) {
  const other = conv?.kind === 'direct' ? conv.participants.find((p) => p.id !== meId) : null;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      {conv && <ConversationAvatar conv={conv} meId={meId} size={80} className="mb-4 shadow-lift" />}
      <h3 className="text-lg font-bold text-fg">{conv?.title ?? 'New conversation'}</h3>
      <p className="mt-1 max-w-xs text-sm text-muted">
        {other ? `Send ${shortName(other)} a message to get the conversation going.` : 'No messages yet. Be the first to say something!'}
      </p>
      <Button className="mt-5" variant="soft" onClick={onWave}>
        <span className="mr-1 text-lg leading-none">👋</span> Say hi
      </Button>
    </div>
  );
}

function ChatSkeleton() {
  const rows = [
    { own: false, w: 'w-44' },
    { own: false, w: 'w-64' },
    { own: true, w: 'w-52' },
    { own: false, w: 'w-36' },
    { own: true, w: 'w-60' },
    { own: true, w: 'w-28' },
    { own: false, w: 'w-56' },
  ];
  return (
    <div className="flex flex-col gap-3 py-4" aria-busy="true" aria-label="Loading messages">
      {rows.map((r, i) => (
        <div key={i} className={cn('flex items-end gap-2', r.own && 'flex-row-reverse')}>
          {!r.own && <Skeleton circle className="size-8" />}
          <Skeleton className={cn('h-10 rounded-[20px]', r.w)} />
        </div>
      ))}
    </div>
  );
}
