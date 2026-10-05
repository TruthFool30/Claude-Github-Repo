// Small shared presentational pieces for the messages module.
import { Fragment, type ReactNode } from 'react';
import { Home } from 'lucide-react';
import { format, isThisYear, isToday, isYesterday, differenceInCalendarDays } from 'date-fns';
import { cn } from '../../lib/cn';
import { readableOn } from '../../lib/color';
import { firstName, toDate } from '../../lib/format';
import { Avatar, AvatarStack } from '../../ui';
import type { Member } from '../../lib/types';
import type { Conversation, Participant } from './types';

/**
 * Everyone who might have authored a message: current participants first, then other family
 * members (e.g. someone who left the group but is still in the family). Only people no longer in
 * the family end up unknown ("Former member").
 */
export function knownPeople(participants: Participant[], members: Member[]): Participant[] {
  const out = new Map<number, Participant>();
  for (const m of members) {
    out.set(m.id, { id: m.id, name: m.name, color: m.color, avatar_url: m.avatar_url, role: m.role, nickname: m.nickname, managed: m.managed, last_read_id: 0, joined_at: '' });
  }
  for (const p of participants) out.set(p.id, p);
  return [...out.values()];
}

export const ACCENT = '#8E4EC6';
export const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🎉'];
export const EMOJI_SET = [
  '😀', '😂', '🥹', '😊', '😍', '🥰', '😘', '😎', '🤩', '🤗', '🤔', '😴', '😮', '😢', '😭', '😡',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👋', '🤞', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨',
  '🎉', '🎂', '🎈', '🎁', '⚽️', '🏀', '🎮', '🎨', '📚', '🎵', '🍕', '🌮', '🥞', '🍦', '☕️', '🍿',
  '🐶', '🐱', '🌻', '🌈', '☀️', '🌧️', '🏖️', '⛺', '🚗', '✈️', '🏡', '✅', '❓', '💯',
];
export const GROUP_EMOJIS = ['💬', '🏡', '⛺', '⚽️', '🎂', '🎉', '🍕', '🎮', '📚', '🎵', '✈️', '🐶', '❤️', '🛒'];

/** Short time for list rows: "3:12 PM" today, "Yesterday", weekday within a week, else "Sep 12". */
export function listTime(value: string | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return 'Yesterday';
  if (differenceInCalendarDays(new Date(), d) < 7) return format(d, 'EEE');
  return format(d, isThisYear(d) ? 'MMM d' : 'MMM d, yyyy');
}

/** Day separator label: "Today" / "Yesterday" / "Monday" / "Mon, Sep 12". */
export function dayLabel(value: string): string {
  const d = toDate(value)!;
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  if (differenceInCalendarDays(new Date(), d) < 7) return format(d, 'EEEE');
  return format(d, isThisYear(d) ? 'EEE, MMM d' : 'EEE, MMM d, yyyy');
}

export const shortName = (p: { name: string; nickname?: string | null } | null | undefined) =>
  p ? p.nickname || firstName(p.name) : 'Someone';

/** "Alex, Sam and Mia" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Avatar for a conversation: member photo (DM), emoji tile (group) or house tile (Family). */
export function ConversationAvatar({ conv, meId, size = 48, className }: { conv: Conversation; meId: number; size?: number; className?: string }) {
  if (conv.kind === 'direct') {
    const other = conv.participants.find((p) => p.id !== meId);
    const avatarSize = size >= 64 ? 'xl' : size >= 48 ? 'lg' : size >= 36 ? 'md' : 'sm';
    return <Avatar user={other ?? { name: '?', color: '#8d90a0' }} size={avatarSize} className={className} title="" />;
  }
  const color = conv.kind === 'family' ? ACCENT : conv.color || '#5B5BD6';
  const { bg, fg } = readableOn(color);
  const radius = Math.round(size * 0.32);
  if (conv.kind === 'group' && !conv.emoji) {
    return (
      <span className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }}>
        <AvatarStack users={conv.participants.filter((p) => p.id !== meId).slice(0, 2)} max={2} size={size >= 48 ? 'sm' : 'xs'} />
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center shadow-xs', className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background:
          conv.kind === 'family'
            ? `linear-gradient(145deg, ${bg}, color-mix(in oklab, ${bg} 70%, #D6409F))`
            : `linear-gradient(145deg, color-mix(in oklab, ${color} 22%, var(--surface)), color-mix(in oklab, ${color} 38%, var(--surface)))`,
        color: conv.kind === 'family' ? fg : undefined,
        border: conv.kind === 'group' ? `1px solid color-mix(in oklab, ${color} 30%, transparent)` : undefined,
      }}
      aria-hidden
    >
      {conv.kind === 'family' ? (
        <Home size={Math.round(size * 0.46)} strokeWidth={2.2} />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.5), lineHeight: 1 }}>{conv.emoji}</span>
      )}
    </span>
  );
}

/** Subtitle under a conversation's title in the chat header. */
export function conversationSubtitle(conv: Conversation, meId: number): string {
  if (conv.kind === 'direct') {
    const other = conv.participants.find((p) => p.id !== meId);
    if (!other) return 'No longer in the family';
    return { admin: 'Family admin', member: 'Family member', child: 'Family member' }[other.role];
  }
  const others = conv.participants.filter((p) => p.id !== meId).map(shortName);
  if (conv.kind === 'family') return `Everyone · ${conv.participants.length} members`;
  return others.length ? `You, ${joinNames(others)}` : 'Just you';
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

/** Message text with clickable links and highlighted @mentions. */
export function RichText({ text, participants, own }: { text: string; participants: Participant[]; own: boolean }) {
  const names = participants.flatMap((p) => [firstName(p.name), p.nickname].filter(Boolean) as string[]);
  const mentionRe = names.length
    ? new RegExp(`(@(?:${[...names, 'all', 'everyone', 'family'].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))(?![\\p{L}\\p{N}_])`, 'giu')
    : null;
  const parts: ReactNode[] = [];
  text.split(URL_RE).forEach((chunk, i) => {
    if (i % 2 === 1) {
      parts.push(
        <a
          key={`u${i}`}
          href={chunk}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('break-all underline underline-offset-2', own ? 'text-white decoration-white/60' : 'text-primary decoration-primary/40')}
          onClick={(e) => e.stopPropagation()}
        >
          {chunk}
        </a>,
      );
      return;
    }
    if (!mentionRe) {
      parts.push(<Fragment key={`t${i}`}>{chunk}</Fragment>);
      return;
    }
    chunk.split(mentionRe).forEach((piece, j) => {
      if (j % 2 === 1) {
        parts.push(
          <span key={`m${i}-${j}`} className={cn('rounded px-0.5 font-semibold', own ? 'bg-white/20' : 'bg-primary-soft text-primary-soft-fg')}>
            {piece}
          </span>,
        );
      } else if (piece) parts.push(<Fragment key={`t${i}-${j}`}>{piece}</Fragment>);
    });
  });
  return <>{parts}</>;
}

/** 1–3 emoji and nothing else → render big without a bubble. */
export function isJumboEmoji(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  if (/[\p{L}\p{N}]/u.test(t.replace(/\p{Extended_Pictographic}|\p{Emoji_Component}/gu, ''))) return false;
  const pics = t.match(/\p{Extended_Pictographic}/gu) ?? [];
  return pics.length >= 1 && pics.length <= 3 && t.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\s‍️]/gu, '') === '';
}

/** Animated three-dot typing bubble. */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 animate-bounce rounded-full bg-current opacity-70" style={{ animationDelay: `${i * 150}ms`, animationDuration: '1s' }} />
      ))}
    </span>
  );
}
