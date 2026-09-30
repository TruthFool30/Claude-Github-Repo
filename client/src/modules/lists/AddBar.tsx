import { forwardRef, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, CalendarPlus, Plus, UserPlus, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName } from '../../lib/format';
import type { Member } from '../../lib/types';
import { Avatar, Popover } from '../../ui';
import { DueChip, duePresets } from './bits';
import { categoryEmoji, guessCategory, parseQuantity } from './categories';
import type { ItemInput, ListType } from './types';

export interface AddBarProps {
  listType: ListType;
  color: string;
  onAdd: (input: ItemInput & { text: string }) => void;
}

/** Match a leading/trailing "@name" to a family member (first name or nickname, case-insensitive). */
function extractMention(text: string, members: Member[]): { text: string; member: Member | null } {
  const m = text.match(/(^|\s)@([\p{L}\p{N}_-]+)/u);
  if (!m) return { text, member: null };
  const q = m[2].toLowerCase();
  const member =
    members.find((x) => (x.nickname ?? '').toLowerCase() === q || firstName(x.name).toLowerCase() === q) ??
    members.find((x) => firstName(x.name).toLowerCase().startsWith(q)) ??
    null;
  if (!member) return { text, member: null };
  return { text: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim(), member };
}

/** Fast add: Enter adds and keeps focus. Shopping shows the guessed aisle; to-dos get sticky assignee + due. */
export const AddBar = forwardRef<HTMLInputElement, AddBarProps>(function AddBar({ listType, color, onAdd }, ref) {
  const { members, role, user } = useAuth();
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState<number | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [openPop, setOpenPop] = useState<'who' | 'due' | null>(null);
  const whoRef = useRef<HTMLButtonElement>(null);
  const dueRef = useRef<HTMLButtonElement>(null);
  const isShopping = listType === 'shopping';
  const assignable = role === 'child' ? members.filter((m) => m.id === user?.id) : members;

  const preview = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const mention = extractMention(trimmed, assignable);
    const parsed = parseQuantity(mention.text);
    return { ...parsed, member: mention.member, category: isShopping ? guessCategory(parsed.text) : null };
  }, [text, assignable, isShopping]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!preview || !preview.text) return;
    const who = preview.member?.id ?? assignee;
    onAdd({
      text: preview.text,
      quantity: preview.quantity,
      ...(who ? { assignee_id: who } : {}),
      ...(due && !isShopping ? { due_date: due } : {}),
    });
    setText('');
  };

  const assigneeMember = members.find((m) => m.id === assignee) ?? null;
  const placeholder = isShopping ? 'Add an item — try “Milk x2”' : listType === 'todo' ? 'Add a task — try “@Mia”' : 'Add an item';

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-border bg-surface shadow-card transition focus-within:border-border-strong focus-within:shadow-lift"
    >
      <div className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`, color }} aria-hidden>
          <Plus size={17} strokeWidth={2.5} />
        </span>
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && text) {
              e.preventDefault();
              e.stopPropagation();
              setText('');
            }
          }}
          maxLength={220}
          enterKeyHint="enter"
          autoComplete="off"
          aria-label={isShopping ? 'Add an item' : 'Add a task'}
          placeholder={placeholder}
          className="h-10 min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-subtle sm:text-[15px]"
        />
        {preview?.category && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-[12px] font-medium text-muted animate-pop-in" aria-live="polite">
            <span aria-hidden>{categoryEmoji(preview.category)}</span> {preview.category}
          </span>
        )}
        {preview?.member && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2 text-[12px] font-medium text-muted animate-pop-in">
            <Avatar user={preview.member} size="xs" /> {firstName(preview.member.name)}
          </span>
        )}
        <button
          type="submit"
          disabled={!preview?.text}
          aria-label="Add"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl text-white transition active:scale-90 disabled:opacity-0"
          style={{ backgroundColor: `color-mix(in oklab, ${color} 80%, black)` }}
        >
          <ArrowUp size={18} strokeWidth={2.5} />
        </button>
      </div>
      {!isShopping && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-2.5 py-1.5">
          <button
            ref={whoRef}
            type="button"
            onClick={() => setOpenPop(openPop === 'who' ? null : 'who')}
            aria-haspopup="dialog"
            aria-expanded={openPop === 'who'}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition hover:bg-surface-2',
              assigneeMember ? 'bg-surface-2 pl-1 text-fg' : 'text-muted',
            )}
          >
            {assigneeMember ? <Avatar user={assigneeMember} size="xs" /> : <UserPlus size={15} aria-hidden />}
            {assigneeMember ? `For ${firstName(assigneeMember.name)}` : 'Assign'}
          </button>
          {assigneeMember && (
            <button type="button" aria-label="Clear assignee" onClick={() => setAssignee(null)} className="-ml-1 rounded-full p-1 text-subtle hover:text-fg">
              <X size={14} />
            </button>
          )}
          <button
            ref={dueRef}
            type="button"
            onClick={() => setOpenPop(openPop === 'due' ? null : 'due')}
            aria-haspopup="dialog"
            aria-expanded={openPop === 'due'}
            className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition hover:bg-surface-2', due ? 'text-fg' : 'text-muted')}
          >
            {due ? <DueChip due={due} className="-ml-1" /> : (<><CalendarPlus size={15} aria-hidden /> Due date</>)}
          </button>
          {due && (
            <button type="button" aria-label="Clear due date" onClick={() => setDue(null)} className="-ml-1 rounded-full p-1 text-subtle hover:text-fg">
              <X size={14} />
            </button>
          )}
          {(assigneeMember || due) && <span className="ml-auto hidden text-[12px] text-subtle sm:inline">Applies to new tasks</span>}
        </div>
      )}
      <Popover open={openPop === 'who'} onClose={() => setOpenPop(null)} anchorRef={whoRef} align="start" className="w-60 p-1.5" role="dialog" aria-label="Assign new tasks to">
        <div className="flex flex-col">
          {assignable.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setAssignee(m.id === assignee ? null : m.id);
                setOpenPop(null);
              }}
              className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-surface-2', m.id === assignee && 'bg-surface-2')}
            >
              <Avatar user={m} size="sm" />
              <span className="flex-1">{m.nickname || m.name}</span>
              {m.id === user?.id && <span className="text-xs text-subtle">You</span>}
            </button>
          ))}
        </div>
      </Popover>
      <Popover open={openPop === 'due'} onClose={() => setOpenPop(null)} anchorRef={dueRef} align="start" className="w-64 p-3" role="dialog" aria-label="Due date for new tasks">
        <div className="grid grid-cols-2 gap-1.5">
          {duePresets().map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setDue(p.value);
                setOpenPop(null);
              }}
              className={cn('rounded-lg border px-2 py-2 text-[13px] font-medium transition hover:bg-surface-2', due === p.value ? 'border-primary text-primary' : 'border-border text-fg')}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="mt-3 block text-[12px] font-medium text-muted">
          Pick a date
          <input
            type="date"
            value={due ?? ''}
            onChange={(e) => setDue(e.target.value || null)}
            className="mt-1 block h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-primary"
          />
        </label>
      </Popover>
    </form>
  );
});
