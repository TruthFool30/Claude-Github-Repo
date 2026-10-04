import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { BellOff, Camera, MessageCirclePlus, Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { EmptyState, Button, Input, Skeleton } from '../../ui';
import { useTyping, typingNames, typingLabel } from './data';
import { getDraft, useDraftsVersion } from './drafts';
import { useAuth } from '../../lib/auth';
import { ACCENT, ConversationAvatar, TypingDots, listTime, shortName } from './parts';
import type { Conversation } from './types';
import type { Member } from '../../lib/types';

function preview(conv: Conversation, meId: number, members: Member[]): { who: string | null; text: string; photo: boolean } {
  const m = conv.last_message;
  if (!m) return { who: null, text: conv.kind === 'direct' ? 'Say hi 👋' : 'No messages yet', photo: false };
  const author = conv.participants.find((p) => p.id === m.user_id) ?? members.find((p) => p.id === m.user_id);
  const who = m.user_id === meId ? 'You' : conv.kind === 'direct' && m.kind === 'text' ? null : shortName(author);
  if (m.kind === 'system') return { who: null, text: `${m.user_id === meId ? 'You' : shortName(author)} ${m.body}`, photo: false };
  if (m.deleted) return { who, text: 'Message deleted', photo: false };
  if (!m.body && m.attachments) return { who, text: m.attachments === 1 ? 'Photo' : `${m.attachments} photos`, photo: true };
  return { who, text: m.body, photo: m.attachments > 0 };
}

export function ConversationList({
  conversations, loading, activeId, meId, onNew, className,
}: {
  conversations: Conversation[] | undefined;
  loading: boolean;
  activeId: number | null;
  meId: number;
  onNew: () => void;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const typing = useTyping();
  const { familyId, members } = useAuth();
  useDraftsVersion();
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!conversations) return [];
    if (!needle) return conversations;
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(needle) || c.participants.some((p) => p.name.toLowerCase().includes(needle)),
    );
  }, [conversations, q]);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="px-3 pb-2 pt-3 sm:px-4">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          icon={Search}
          trailing={
            q ? (
              <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="inline-flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg">
                <X size={16} />
              </button>
            ) : undefined
          }
        />
      </div>
      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 scrollbar-thin">
        {loading && !conversations ? (
          <div className="space-y-1 p-1" aria-busy="true" aria-label="Loading conversations">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-2xl px-2 py-2.5">
                <Skeleton circle className="size-12" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          q ? (
            <p className="px-4 py-10 text-center text-sm text-muted">No conversations match “{q}”.</p>
          ) : (
            <EmptyState
              compact
              icon={MessageCirclePlus}
              accent={ACCENT}
              title="No conversations yet"
              description="Start a chat with someone in your family."
              action={<Button onClick={onNew} icon={MessageCirclePlus}>New chat</Button>}
            />
          )
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((c) => {
              const p = preview(c, meId, members);
              const names = typingNames(typing, c.id);
              const draft = c.id === activeId ? '' : getDraft(meId, familyId ?? 0, c.id).trim();
              const active = c.id === activeId;
              const unread = c.unread > 0;
              return (
                <li key={c.id}>
                  <Link
                    to={`/messages/${c.id}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={`${c.title}${unread ? `, ${c.unread} unread` : ''}${c.muted ? ', muted' : ''}`}
                    className={cn(
                      'group flex items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors',
                      'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                      active ? 'bg-primary-soft' : 'hover:bg-surface-2',
                    )}
                  >
                    <ConversationAvatar conv={c} meId={meId} size={48} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className={cn('min-w-0 flex-1 truncate text-[15px] text-fg', unread ? 'font-bold' : 'font-semibold')}>{c.title}</span>
                        <span className={cn('shrink-0 text-xs tabular-nums', unread && !c.muted ? 'font-semibold text-primary' : 'text-subtle')}>
                          {listTime(c.last_message?.created_at ?? c.last_activity_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        {names.length ? (
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13.5px] font-medium text-primary">
                            <TypingDots />
                            <span className="truncate">{typingLabel(names)}</span>
                          </span>
                        ) : draft ? (
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted">
                            <span className="font-semibold text-danger">Draft: </span>
                            {draft.replace(/\s+/g, ' ')}
                          </span>
                        ) : (
                          <span className={cn('min-w-0 flex-1 truncate text-[13.5px]', unread ? 'font-medium text-fg' : 'text-muted')}>
                            {p.who && <span className={unread ? 'text-fg' : 'text-subtle'}>{p.who}: </span>}
                            {p.photo && <Camera size={13} className="-mt-0.5 mr-1 inline" aria-hidden />}
                            {p.text}
                          </span>
                        )}
                        {c.muted && <BellOff size={14} className="shrink-0 text-subtle" aria-hidden />}
                        {unread && (
                          <span
                            aria-hidden
                            className={cn(
                              'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums',
                              c.muted ? 'bg-surface-3 text-muted' : 'bg-primary-solid text-white',
                            )}
                          >
                            {c.unread > 99 ? '99+' : c.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
