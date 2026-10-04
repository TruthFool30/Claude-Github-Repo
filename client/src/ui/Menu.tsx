import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { renderIcon, type IconLike } from './icon';
import { IconButton } from './IconButton';
import { Popover } from './Popover';

export interface MenuItem {
  label: ReactNode;
  icon?: IconLike;
  onSelect?: () => void;
  /** Navigate instead of calling onSelect. */
  href?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Small right-aligned hint (e.g. shortcut). */
  hint?: ReactNode;
}
/** Use the string 'divider' between groups. */
export type MenuEntry = MenuItem | 'divider' | null | false | undefined;

export interface MenuProps {
  items: MenuEntry[];
  /**
   * Custom trigger. Render prop receives `{ open, toggle }`; spread nothing — the wrapper handles
   * clicks/keys. Default: a "…" IconButton.
   */
  trigger?: (state: { open: boolean }) => ReactNode;
  /** aria-label for the default trigger. */
  label?: string;
  align?: 'start' | 'end';
  className?: string;
  menuClassName?: string;
}

/**
 * Dropdown actions menu with full keyboard support (↑/↓, Home/End, Enter/Space, Esc, type-ahead).
 *   <Menu items={[{ label: 'Rename', icon: Pencil, onSelect }, 'divider', { label: 'Delete', icon: Trash2, danger: true, onSelect }]} />
 */
export function Menu({ items, trigger, label = 'More actions', align = 'end', className, menuClassName }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const navigate = useNavigate();
  const typeahead = useRef({ buf: '', t: 0 });

  const entries = items.filter(Boolean) as Array<MenuItem | 'divider'>;
  const actionable = entries.map((e, i) => (e !== 'divider' && !e.disabled ? i : -1)).filter((i) => i >= 0);

  const triggerEl = () => anchorRef.current?.querySelector<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])') ?? null;
  const close = useCallback((refocus = true) => {
    setOpen(false);
    setActive(-1);
    if (refocus) triggerEl()?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ARIA state lives on the real trigger button (not the wrapper span).
  const menuId = useId();
  useEffect(() => {
    const el = triggerEl();
    if (!el) return;
    el.setAttribute('aria-haspopup', 'menu');
    el.setAttribute('aria-expanded', String(open));
    if (open) el.setAttribute('aria-controls', menuId);
    else el.removeAttribute('aria-controls');
  });

  // Focus the active item (the popover mounts a frame after `open` flips, so retry briefly).
  useEffect(() => {
    if (!open || active < 0) return;
    let raf = 0;
    let tries = 0;
    const focus = () => {
      const el = itemRefs.current[active];
      if (el) el.focus({ preventScroll: true });
      else if (tries++ < 10) raf = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(raf);
  }, [open, active]);

  const openWith = (which: 'first' | 'last') => {
    setOpen(true);
    setActive(which === 'first' ? actionable[0] ?? -1 : actionable[actionable.length - 1] ?? -1);
  };

  const select = (item: MenuItem) => {
    close(!item.href);
    if (item.href) navigate(item.href);
    else item.onSelect?.();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const pos = actionable.indexOf(active);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(actionable[(pos + 1) % actionable.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(actionable[(pos - 1 + actionable.length) % actionable.length]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(actionable[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(actionable[actionable.length - 1]);
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      const ta = typeahead.current;
      ta.buf = now - ta.t > 600 ? e.key.toLowerCase() : ta.buf + e.key.toLowerCase();
      ta.t = now;
      const match = actionable.find((i) => {
        const el = itemRefs.current[i];
        return el?.textContent?.trim().toLowerCase().startsWith(ta.buf);
      });
      if (match !== undefined) setActive(match);
    }
  };

  return (
    <>
      <span
        ref={anchorRef}
        className={cn('inline-flex', className)}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close(false);
          else openWith('first');
        }}
        onKeyDown={(e) => {
          if (open) {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) onMenuKey(e);
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openWith('first');
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openWith('last');
          }
        }}
      >
        {trigger ? trigger({ open }) : <IconButton icon={MoreHorizontal} label={label} size="sm" />}
      </span>
      <Popover
        open={open}
        onClose={(reason) => {
          if (reason === 'escape') return close(true);
          close(false);
          // Clicked somewhere non-focusable: don't strand keyboard focus on <body>.
          requestAnimationFrame(() => {
            if (!document.activeElement || document.activeElement === document.body) triggerEl()?.focus({ preventScroll: true });
          });
        }}
        anchorRef={anchorRef}
        align={align}
        role="menu"
        id={menuId}
        className={cn('min-w-[200px] max-w-[280px] p-1.5', menuClassName)}
      >
        <div onKeyDown={onMenuKey} onClick={(e) => e.stopPropagation()}>
          {entries.map((entry, i) =>
            entry === 'divider' ? (
              <div key={`d${i}`} role="separator" className="-mx-1.5 my-1.5 h-px bg-border" />
            ) : (
              <button
                key={i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="menuitem"
                type="button"
                tabIndex={active === i ? 0 : -1}
                disabled={entry.disabled}
                onMouseEnter={() => !entry.disabled && setActive(i)}
                onClick={() => select(entry)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium outline-none transition-colors',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                  entry.danger ? 'text-danger focus:bg-danger-soft' : 'text-fg focus:bg-surface-2',
                )}
              >
                <span className={cn('shrink-0', entry.danger ? 'text-danger' : 'text-muted')}>{renderIcon(entry.icon, undefined, 17)}</span>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint && <span className="text-xs text-subtle">{entry.hint}</span>}
              </button>
            ),
          )}
        </div>
      </Popover>
    </>
  );
}
