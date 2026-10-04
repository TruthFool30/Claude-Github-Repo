import { memo, useRef } from 'react';
import { AlertCircle, Copy, CornerUpLeft, MoreHorizontal, Pencil, RotateCw, SmilePlus, Trash2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { fmtDateTime, fmtTime } from '../../lib/format';
import { Avatar, Menu } from '../../ui';
import { EmojiPicker } from './EmojiPicker';
import { QUICK_REACTIONS, RichText, isJumboEmoji, shortName } from './parts';
import type { Message, Participant } from './types';

export type GroupPos = 'single' | 'first' | 'middle' | 'last';

export interface BubbleProps {
  message: Message;
  own: boolean;
  author: Participant | undefined;
  participants: Participant[];
  meId: number;
  pos: GroupPos;
  showName: boolean;
  canDelete: boolean;
  touch: boolean;
  highlighted: boolean;
  onReply: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onEdit: (m: Message) => void;
  onDelete: (m: Message) => void;
  onCopy: (m: Message) => void;
  onRetry: (m: Message) => void;
  onDiscard: (m: Message) => void;
  onOpenImage: (m: Message, index: number) => void;
  onJumpTo: (id: number) => void;
  onActions: (m: Message) => void;
}

function Photos({ message, own, onOpen }: { message: Message; own: boolean; onOpen: (i: number) => void }) {
  const list = message.attachments;
  if (!list.length) return null;
  const single = list.length === 1;
  const a0 = list[0];
  const ratio = single && a0.width && a0.height ? Math.min(1.6, Math.max(0.6, a0.width / a0.height)) : 4 / 3;
  return (
    <div
      className={cn('grid gap-1 overflow-hidden rounded-2xl', single ? 'grid-cols-1' : 'grid-cols-2', own ? 'justify-self-end' : '')}
      style={{ width: single ? `min(100%, ${Math.round(260 * Math.min(ratio, 1.25))}px)` : 'min(100%, 280px)' }}
    >
      {list.slice(0, 4).map((a, i) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpen(i)}
          aria-label={`Open photo ${i + 1} of ${list.length}`}
          className={cn(
            'group/photo relative overflow-hidden bg-surface-3 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
            list.length === 3 && i === 0 && 'col-span-2',
          )}
          style={{ aspectRatio: single ? String(ratio) : list.length === 3 && i === 0 ? '2 / 1' : '1 / 1' }}
        >
          <img src={a.url} alt="" loading="lazy" draggable={false} className={cn('size-full object-cover transition duration-300 group-hover/photo:scale-[1.03]', a.local && 'opacity-60')} />
          {i === 3 && list.length > 4 && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xl font-bold text-white">+{list.length - 4}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function BubbleImpl(props: BubbleProps) {
  const { message: m, own, author, participants, meId, pos, showName, canDelete, touch, highlighted } = props;
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moved = useRef(false);

  if (m.kind === 'system') {
    return (
      <div className="flex justify-center py-1.5">
        <span className="max-w-[85%] rounded-full bg-surface-2 px-3 py-1 text-center text-xs font-medium text-muted">
          {m.user_id === meId ? 'You' : shortName(author)} {m.body} · {fmtTime(m.created_at)}
        </span>
      </div>
    );
  }

  const jumbo = !m.deleted && !m.attachments.length && !m.reply_to && isJumboEmoji(m.body);
  const hasText = !!m.body && !m.deleted;
  const top = pos === 'single' || pos === 'first';
  const bottom = pos === 'single' || pos === 'last';
  const radius = own
    ? cn('rounded-[20px]', !top && 'rounded-tr-md', !bottom && 'rounded-br-md')
    : cn('rounded-[20px]', !top && 'rounded-tl-md', !bottom && 'rounded-bl-md');
  const interactive = !m.deleted && !m.pending && !m.failed;
  const authorName = own ? 'You' : author?.name ?? 'Former member';

  const startPress = () => {
    if (!touch || !interactive) return;
    moved.current = false;
    pressTimer.current = setTimeout(() => {
      if (!moved.current) {
        navigator.vibrate?.(10);
        props.onActions(m);
      }
    }, 420);
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const reactions = m.reactions.filter((r) => r.user_ids.length);
  const nameOf = (id: number) => (id === meId ? 'You' : shortName(participants.find((p) => p.id === id)));

  return (
    <div
      data-message-id={m.id}
      className={cn('group/msg relative flex items-end gap-2', own ? 'flex-row-reverse' : 'flex-row', bottom ? 'mb-2' : 'mb-0.5')}
    >
      {!own && (
        <div className="w-8 shrink-0">
          {bottom && <Avatar user={author ?? { name: '?', color: '#8d90a0' }} size="sm" title={author?.name} />}
        </div>
      )}
      <div className={cn('flex min-w-0 max-w-[82%] flex-col sm:max-w-[70%]', own ? 'items-end' : 'items-start')}>
        {showName && !own && top && (
          <span className="mb-1 ml-3 text-xs font-semibold" style={{ color: author ? `color-mix(in oklab, ${author.color} 75%, var(--fg))` : undefined }}>
            {author ? shortName(author) : 'Former member'}
          </span>
        )}
        <div
          className={cn('relative flex max-w-full flex-col gap-1', own ? 'items-end' : 'items-start')}
          onTouchStart={startPress}
          onTouchMove={() => {
            moved.current = true;
            cancelPress();
          }}
          onTouchEnd={cancelPress}
          onContextMenu={(e) => {
            if (touch && interactive) {
              e.preventDefault();
              props.onActions(m);
            }
          }}
        >
          {m.reply_to && !m.deleted && (
            <button
              type="button"
              onClick={() => props.onJumpTo(m.reply_to!.id)}
              className={cn(
                'flex max-w-full items-stretch gap-2 rounded-2xl bg-surface-2 px-3 py-1.5 text-left text-[13px] text-muted transition hover:bg-surface-3',
                own ? 'mr-1' : 'ml-1',
              )}
              aria-label={m.reply_to.hidden ? 'Reply to an earlier message that is unavailable' : `Reply to ${nameOf(m.reply_to.user_id ?? 0)}: ${m.reply_to.body || 'photo'}`}
            >
              <span className="w-0.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-[11.5px] font-semibold text-fg">
                  <CornerUpLeft size={11} aria-hidden /> {m.reply_to.hidden ? 'Reply' : m.reply_to.user_id ? nameOf(m.reply_to.user_id) : 'Someone'}
                </span>
                <span className={cn('line-clamp-2 break-words', (m.reply_to.hidden || m.reply_to.deleted) && 'italic')}>
                  {m.reply_to.hidden ? 'Earlier message unavailable' : m.reply_to.deleted ? 'Message deleted' : m.reply_to.body || '📷 Photo'}
                </span>
              </span>
            </button>
          )}
          {!m.deleted && <Photos message={m} own={own} onOpen={(i) => props.onOpenImage(m, i)} />}
          {m.deleted ? (
            <div className={cn('px-3.5 py-2 text-[14px] italic text-subtle ring-1 ring-inset ring-border', radius)}>
              {own ? 'You deleted this message' : 'This message was deleted'}
            </div>
          ) : jumbo ? (
            <div className="px-1 text-[44px] leading-tight" aria-label={m.body}>{m.body}</div>
          ) : hasText ? (
            <div
              className={cn(
                'whitespace-pre-wrap break-words px-3.5 py-2 text-[15px] leading-snug transition-shadow',
                radius,
                own ? 'bg-primary-solid text-white' : 'bg-surface text-fg ring-1 ring-inset ring-border dark:bg-surface-2',
                highlighted && 'ring-4 ring-warning/60',
                m.failed && 'opacity-70',
              )}
            >
              <RichText text={m.body} participants={participants} own={own} />
            </div>
          ) : null}
        </div>

        {reactions.length > 0 && (
          <div className={cn('-mt-1 flex flex-wrap gap-1 px-1.5', own ? 'justify-end' : 'justify-start')}>
            {reactions.map((r) => {
              const mine = r.user_ids.includes(meId);
              const who = r.user_ids.map(nameOf).join(', ');
              return (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => props.onReact(m, r.emoji)}
                  title={who}
                  aria-label={`${r.emoji} ${r.user_ids.length}: ${who}${mine ? '. Tap to remove yours' : ''}`}
                  aria-pressed={mine}
                  className={cn(
                    'relative z-[1] inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-[13px] shadow-xs transition active:scale-90 animate-pop-in',
                    mine ? 'border-primary/50 bg-primary-soft text-primary-soft-fg' : 'border-border bg-surface text-muted hover:border-border-strong',
                  )}
                >
                  <span className="leading-none">{r.emoji}</span>
                  {r.user_ids.length > 1 && <span className="text-[11.5px] font-semibold tabular-nums">{r.user_ids.length}</span>}
                </button>
              );
            })}
          </div>
        )}

        {(bottom || m.pending || m.failed) && (
          <div className={cn('mt-0.5 flex items-center gap-1.5 px-2 text-[11px] text-subtle', own ? 'flex-row-reverse' : '')}>
            {m.failed ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-danger">
                <AlertCircle size={12} aria-hidden /> Not sent ·
                <button type="button" onClick={() => props.onRetry(m)} className="inline-flex items-center gap-0.5 hover:underline">
                  Retry <RotateCw size={11} aria-hidden />
                </button>
                ·
                <button type="button" onClick={() => props.onDiscard(m)} className="hover:underline">Discard</button>
              </span>
            ) : m.pending ? (
              <span>Sending…</span>
            ) : (
              <time dateTime={m.created_at} title={fmtDateTime(m.created_at)}>{fmtTime(m.created_at)}</time>
            )}
            {m.edited_at && !m.deleted && <span>· edited</span>}
          </div>
        )}
      </div>

      {/* Hover / focus toolbar (pointer devices). */}
      {interactive && !touch && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5 self-center rounded-full border border-border bg-surface p-0.5 opacity-0 shadow-card transition-opacity',
            'group-hover/msg:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100',
          )}
        >
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`React ${e}`}
              onClick={() => props.onReact(m, e)}
              className="flex size-7 items-center justify-center rounded-full text-[15px] transition hover:scale-110 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {e}
            </button>
          ))}
          <EmojiPicker
            align={own ? 'end' : 'start'}
            label="More reactions"
            onPick={(e) => props.onReact(m, e)}
            trigger={(t) => (
              <button type="button" {...t} aria-label="More reactions" className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <SmilePlus size={15} />
              </button>
            )}
          />
          <button
            type="button"
            aria-label={`Reply to ${authorName}`}
            onClick={() => props.onReply(m)}
            className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CornerUpLeft size={15} />
          </button>
          <Menu
            label="Message actions"
            align={own ? 'end' : 'start'}
            trigger={() => (
              <button type="button" aria-label="Message actions" className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <MoreHorizontal size={15} />
              </button>
            )}
            items={[
              { label: 'Reply', icon: CornerUpLeft, onSelect: () => props.onReply(m) },
              hasText && { label: 'Copy text', icon: Copy, onSelect: () => props.onCopy(m) },
              own && hasText && { label: 'Edit', icon: Pencil, onSelect: () => props.onEdit(m) },
              canDelete && 'divider',
              canDelete && { label: own ? 'Delete' : 'Delete (admin)', icon: Trash2, danger: true, onSelect: () => props.onDelete(m) },
            ]}
          />
        </div>
      )}
    </div>
  );
}

export const MessageBubble = memo(BubbleImpl);
