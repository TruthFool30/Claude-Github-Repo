import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { firstName } from '../../lib/format';
import type { Member } from '../../lib/types';
import { Avatar } from '../../ui';

export interface MentionTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  members: Member[];
  /** Grow with content up to this many px. */
  maxHeight?: number;
  ref?: Ref<HTMLTextAreaElement>;
  /** Preferred side for the suggestion list (it flips when there is no room). */
  placement?: 'below' | 'above';
}

const MIRROR_PROPS = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight',
  'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform',
  'wordSpacing', 'tabSize', 'whiteSpace', 'wordWrap', 'overflowWrap',
] as const;

/** Viewport coordinates of the caret inside a textarea (mirror-div technique). */
function caretRect(el: HTMLTextAreaElement): { left: number; top: number; bottom: number; limit: number } {
  const style = window.getComputedStyle(el);
  const div = document.createElement('div');
  for (const prop of MIRROR_PROPS) div.style[prop] = style[prop];
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.overflowWrap = 'break-word';
  div.style.top = '0';
  div.style.left = '-9999px';
  const pos = el.selectionStart ?? el.value.length;
  div.textContent = el.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  div.appendChild(marker);
  document.body.appendChild(div);
  const rect = el.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const top = rect.top + marker.offsetTop - el.scrollTop;
  const left = rect.left + marker.offsetLeft - el.scrollLeft;
  document.body.removeChild(div);
  // Bottom of the nearest scrolling container (e.g. a dialog body above its footer).
  let limit = window.innerHeight;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = window.getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') {
      limit = p.getBoundingClientRect().bottom;
      break;
    }
  }
  return { left, top, bottom: top + lineHeight, limit };
}

const QUERY = /(^|\s)@([\p{L}]*)$/u;

/**
 * Auto-growing textarea with @mention suggestions for family members
 * (↑/↓ to choose, Enter/Tab to insert, Esc to dismiss).
 */
export function MentionTextarea({
  value, onValueChange, members, maxHeight = 320, className, onKeyDown, ref, placement = 'below', ...rest
}: MentionTextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const pendingCaret = useRef<number | null>(null);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el;
  };

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    if (pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);

  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number; limit: number } | null>(null);

  const suggestions =
    query === null
      ? []
      : members.filter((m) => {
          const q = query.toLowerCase();
          return firstName(m.name).toLowerCase().startsWith(q) || (m.nickname ?? '').toLowerCase().startsWith(q);
        }).slice(0, 5);
  const open = suggestions.length > 0;

  // Position the (portaled) suggestion list at the caret; keep it there on scroll/resize.
  useLayoutEffect(() => {
    if (!open || !inner.current) return;
    setAnchor(caretRect(inner.current));
  }, [open, value, query]);
  useEffect(() => {
    if (!open) return;
    const update = () => inner.current && setAnchor(caretRect(inner.current));
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // Follow the textarea while an enclosing sheet/dialog is still animating into place.
    let raf = 0;
    let last = '';
    const follow = () => {
      const r = inner.current?.getBoundingClientRect();
      const sig = r ? `${Math.round(r.top)}:${Math.round(r.left)}` : '';
      if (sig !== last) {
        last = sig;
        update();
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const sync = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = QUERY.exec(before);
    setQuery(m ? m[2] : null);
    setActive(0);
  };

  const insert = (m: Member) => {
    const el = inner.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = QUERY.exec(before);
    if (!match) return;
    const start = caret - match[2].length - 1;
    const tag = `@${firstName(m.name)} `;
    const next = value.slice(0, start) + tag + value.slice(caret);
    pendingCaret.current = start + tag.length;
    onValueChange(next);
    setQuery(null);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(suggestions[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setQuery(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <textarea
        ref={setRefs}
        value={value}
        rows={1}
        onChange={(e) => {
          onValueChange(e.target.value);
          sync(e.target);
        }}
        onKeyDown={handleKey}
        onClick={(e) => sync(e.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        className={cn('block w-full resize-none bg-transparent text-fg placeholder:text-subtle focus:outline-none', className)}
        {...rest}
      />
      {open && anchor && createPortal(
        <SuggestionList
          id={listId}
          anchor={anchor}
          placement={placement}
          suggestions={suggestions}
          active={active}
          onHover={setActive}
          onPick={insert}
        />,
        document.body,
      )}
    </div>
  );
}

const LIST_W = 232;
const ROW_H = 38;

function SuggestionList({
  id, anchor, placement, suggestions, active, onHover, onPick,
}: {
  id: string; anchor: { left: number; top: number; bottom: number; limit: number }; placement: 'below' | 'above';
  suggestions: Member[]; active: number; onHover: (i: number) => void; onPick: (m: Member) => void;
}) {
  const h = suggestions.length * ROW_H + 10;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // Visual viewport shrinks when the on-screen keyboard is open.
  const visibleBottom = Math.min(anchor.limit, window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : vh);
  const roomBelow = visibleBottom - anchor.bottom - 8;
  const roomAbove = anchor.top - 8;
  const below = placement === 'below' ? roomBelow >= h || roomBelow >= roomAbove : !(roomAbove >= h || roomAbove >= roomBelow);
  const left = Math.max(8, Math.min(anchor.left - 12, vw - LIST_W - 8));
  const style = below ? { top: anchor.bottom + 4, left } : { top: Math.max(8, anchor.top - h - 4), left };
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Mention a family member"
      style={{ ...style, width: LIST_W }}
      className="fixed z-[80] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop animate-pop-in"
    >
      {suggestions.map((m, i) => (
        <li
          key={m.id}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(m);
          }}
          onMouseEnter={() => onHover(i)}
          className={cn('flex h-[38px] cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm', i === active ? 'bg-surface-2 text-fg' : 'text-muted')}
        >
          <Avatar user={m} size="xs" />
          <span className="font-medium text-fg">{firstName(m.name)}</span>
          <span className="truncate text-xs text-subtle">{m.name}</span>
        </li>
      ))}
    </ul>
  );
}
