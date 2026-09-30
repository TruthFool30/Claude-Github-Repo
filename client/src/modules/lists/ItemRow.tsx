import { memo } from 'react';
import { GripVertical, StickyNote } from 'lucide-react';
import { cn } from '../../lib/cn';
import { firstName, fmtRelative } from '../../lib/format';
import type { Member } from '../../lib/types';
import { Avatar, Checkbox } from '../../ui';
import { DueChip } from './bits';
import type { ListItem, ListType } from './types';

export interface ItemRowProps {
  item: ListItem;
  listType: ListType;
  color: string;
  assignee: Member | null;
  doneBy: Member | null;
  /** Item was just checked: keep it in place while the strike-through plays. */
  settling?: boolean;
  highlight?: boolean;
  dragging?: boolean;
  rowRef?: (el: HTMLElement | null) => void;
  handleProps?: Record<string, unknown> | null;
  /** Keep the handle column's width even without a handle (aligns with sortable rows). */
  reserveHandle?: boolean;
  onToggle: (item: ListItem, done: boolean) => void;
  onOpen: (item: ListItem) => void;
  onMoveKey?: (item: ListItem, delta: number) => void;
}

export const ItemRow = memo(function ItemRow({
  item, listType, color, assignee, doneBy, settling, highlight, dragging, rowRef, handleProps, reserveHandle, onToggle, onOpen, onMoveKey,
}: ItemRowProps) {
  const done = item.done;
  const struck = done;
  const pending = item.id < 0;
  return (
    <li
      ref={rowRef}
      data-item-id={item.id}
      className={cn(
        'group relative flex items-center gap-1 bg-surface pr-2 first:rounded-t-2xl last:rounded-b-2xl transition-[background-color,box-shadow,opacity] duration-300',
        dragging && 'shadow-pop ring-1 ring-border-strong',
        highlight && 'animate-[lists-flash_2.2s_ease-out]',
        settling && 'opacity-70',
        pending && 'opacity-70',
      )}
    >
      {handleProps ? (
        <button
          type="button"
          aria-label={`Reorder “${item.text}”. Use arrow up and down keys to move.`}
          className="flex h-11 w-7 shrink-0 cursor-grab items-center justify-center rounded-lg text-subtle opacity-50 transition hover:text-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover:opacity-100"
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              onMoveKey?.(item, e.key === 'ArrowUp' ? -1 : 1);
            }
          }}
          {...handleProps}
        >
          <GripVertical size={16} aria-hidden />
        </button>
      ) : (
        <span className={cn(reserveHandle ? 'w-7' : 'w-2', 'shrink-0')} aria-hidden />
      )}
      <Checkbox
        shape="circle"
        size="lg"
        color={color}
        checked={done}
        disabled={pending}
        className="p-2.5 -m-1"
        aria-label={done ? `Mark “${item.text}” as not done` : `Mark “${item.text}” as done`}
        onChange={(v) => onToggle(item, v)}
      />
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2.5 pl-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${item.text}${item.quantity ? `, ${item.quantity}` : ''}. Open details`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                'relative min-w-0 truncate text-[15px] font-medium leading-snug transition-colors duration-300',
                struck ? 'text-subtle' : 'text-fg',
              )}
            >
              {item.text}
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-1/2 h-[1.5px] origin-left rounded bg-current transition-transform duration-300 ease-out',
                  struck ? 'w-full scale-x-100' : 'w-full scale-x-0',
                )}
              />
            </span>
            {item.quantity && (
              <span
                className={cn('shrink-0 rounded-md px-1.5 py-px text-[12px] font-semibold tabular-nums', done ? 'bg-surface-2 text-subtle' : '')}
                style={done ? undefined : { backgroundColor: `color-mix(in oklab, ${color} 13%, transparent)`, color: `color-mix(in oklab, ${color} 60%, var(--fg))` }}
              >
                {item.quantity}
              </span>
            )}
          </span>
          {(item.notes || (item.due_date && listType !== 'shopping') || (done && doneBy)) && (
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
              {item.due_date && listType !== 'shopping' && <DueChip due={item.due_date} done={done} />}
              {item.notes && !done && (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1 truncate">
                  <StickyNote size={12} aria-hidden className="shrink-0 text-subtle" />
                  <span className="truncate">{item.notes}</span>
                </span>
              )}
              {done && doneBy && (
                <span className="text-subtle">
                  {firstName(doneBy.name)} · {fmtRelative(item.done_at)}
                </span>
              )}
            </span>
          )}
        </span>
        {assignee && (
          <span className="shrink-0" title={`Assigned to ${assignee.name}`}>
            <Avatar user={assignee} size="sm" className={cn(done && 'opacity-50 grayscale')} title={`Assigned to ${assignee.name}`} />
          </span>
        )}
      </button>
    </li>
  );
});
