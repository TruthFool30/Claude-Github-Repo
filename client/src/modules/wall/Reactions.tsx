import { useMemo, useRef, useState } from 'react';
import { SmilePlus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { firstName } from '../../lib/format';
import type { Member } from '../../lib/types';
import { Avatar, Modal, Popover, Tabs } from '../../ui';
import { REACTIONS, reactionMeta } from './moods';
import type { WallReaction } from './types';

/** "React" button: opens a pill of five emoji; picking your current one removes it. */
export function ReactionButton({ mine, onPick }: { mine: string | null; onPick: (emoji: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const meta = mine ? reactionMeta(mine) : null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={meta ? `You reacted ${meta.label}. Change reaction` : 'React'}
        className={cn(
          'inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors sm:flex-none',
          meta ? 'bg-primary-soft text-primary-soft-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )}
      >
        {meta ? <span className="text-base leading-none">{meta.emoji}</span> : <SmilePlus size={18} />}
        {meta ? meta.past : 'React'}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="start" className="rounded-full! p-1.5" role="menu" aria-label="Choose a reaction">
        <div className="flex items-center gap-0.5">
          {REACTIONS.map((r, i) => {
            const on = r.emoji === mine;
            return (
              <button
                key={r.emoji}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                aria-label={on ? `Remove ${r.label} reaction` : `React with ${r.label}`}
                title={r.label}
                autoFocus={i === 0}
                onClick={() => {
                  setOpen(false);
                  onPick(on ? null : r.emoji);
                }}
                style={{ animationDelay: `${i * 30}ms` }}
                className={cn(
                  'flex size-11 items-center justify-center rounded-full text-[26px] leading-none transition-transform duration-150 animate-scale-in hover:-translate-y-1 hover:scale-125 focus-visible:scale-125 focus-visible:outline-none',
                  on && 'bg-primary-soft',
                )}
              >
                {r.emoji}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

/** Emoji bubbles + "Alex, Sam and 2 others" — click to see who reacted with what. */
export function ReactionSummary({ reactions, members, meId }: { reactions: WallReaction[]; members: Member[]; meId?: number }) {
  const [open, setOpen] = useState(false);
  if (!reactions.length) return null;
  const counts = countByEmoji(reactions);
  const names = reactions
    .slice()
    .sort((a, b) => (a.user_id === meId ? -1 : b.user_id === meId ? 1 : 0))
    .map((r) => (r.user_id === meId ? 'You' : firstName(members.find((m) => m.id === r.user_id)?.name) || 'Someone'));
  const label =
    names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'}`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group -ml-1 inline-flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-[13px] text-muted hover:text-fg"
        aria-label={`${reactions.length} reaction${reactions.length === 1 ? '' : 's'}: ${label}. Show who reacted`}
      >
        <span className="flex shrink-0 items-center">
          {counts.map(([emoji], i) => (
            <span
              key={emoji}
              className="flex size-6 items-center justify-center rounded-full bg-surface text-[14px] ring-2 ring-surface"
              style={{ marginLeft: i ? -6 : 0, zIndex: counts.length - i }}
            >
              {emoji}
            </span>
          ))}
        </span>
        <span className="truncate group-hover:underline">{label}</span>
      </button>
      <ReactionsModal open={open} onClose={() => setOpen(false)} reactions={reactions} members={members} />
    </>
  );
}

function countByEmoji(reactions: WallReaction[]) {
  const map = new Map<string, number>();
  for (const r of reactions) map.set(r.emoji, (map.get(r.emoji) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function ReactionsModal({ open, onClose, reactions, members }: { open: boolean; onClose: () => void; reactions: WallReaction[]; members: Member[] }) {
  const [tab, setTab] = useState('all');
  const counts = useMemo(() => countByEmoji(reactions), [reactions]);
  const shown = tab === 'all' ? reactions : reactions.filter((r) => r.emoji === tab);
  return (
    <Modal open={open} onClose={onClose} title="Reactions" size="sm">
      <Tabs
        tabs={[{ id: 'all', label: 'All', count: reactions.length }, ...counts.map(([emoji, n]) => ({ id: emoji, label: emoji, count: n }))]}
        value={tab}
        onChange={setTab}
      />
      <ul className="mt-3 flex flex-col">
        {shown.map((r) => {
          const m = members.find((x) => x.id === r.user_id);
          return (
            <li key={r.user_id} className="flex items-center gap-3 py-2">
              <span className="relative">
                <Avatar user={m ?? { name: 'Former member' }} size="md" />
                <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-surface text-[12px] shadow-card">{r.emoji}</span>
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-fg">{m?.name ?? 'Former member'}</span>
              <span className="text-xs text-subtle">{reactionMeta(r.emoji).label}</span>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
