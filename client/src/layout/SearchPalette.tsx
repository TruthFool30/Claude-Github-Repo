import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CornerDownLeft, Search, Settings, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { useDebounce } from '../lib/hooks';
import { setShell, useShell } from '../lib/shell';
import type { SearchResult } from '../lib/types';
import { modules } from '../modules/registry';
import { Avatar, Spinner } from '../ui';
import { useEscape, useFocusTrap, useOverlayStack, usePresence, useScrollLock } from '../ui/overlay';
import { moduleMeta } from './moduleMeta';
import type { LucideIcon } from 'lucide-react';

interface Row {
  key: string;
  title: string;
  subtitle?: string | null;
  link: string;
  icon: LucideIcon;
  accent: string;
  avatar?: SearchResult['avatar'];
  group: string;
}

const pages: Row[] = [
  ...modules.map((m) => ({ key: `nav-${m.id}`, title: m.label, subtitle: m.description, link: m.path, icon: m.icon, accent: m.accent, group: 'Jump to' })),
  { key: 'nav-family', title: 'Family', subtitle: 'Members, invite code and family settings', link: '/family', icon: Users, accent: '#F76B15', group: 'Jump to' },
  { key: 'nav-settings', title: 'Settings', subtitle: 'Profile, appearance and password', link: '/settings', icon: Settings, accent: '#737889', group: 'Jump to' },
];

/** Cmd/Ctrl+K command palette: page navigation + /api/search results. */
export function SearchPalette() {
  const { searchOpen: open } = useShell();
  const close = () => setShell({ searchOpen: false });
  const { mounted, closing } = usePresence(open, 180);
  const isTop = useOverlayStack(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const term = useDebounce(q.trim(), 200);

  useScrollLock(open);
  useFocusTrap(panelRef, open, isTop);
  useEscape(open, isTop, close);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', term],
    queryFn: () => api.get<{ q: string; results: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}`),
    enabled: open && term.length >= 2,
    staleTime: 10_000,
  });

  const rows = useMemo<Row[]>(() => {
    const needle = q.trim().toLowerCase();
    const nav = needle ? pages.filter((p) => p.title.toLowerCase().includes(needle)) : pages;
    const found: Row[] =
      needle.length >= 2 && data && data.q === term
        ? data.results.map((r, i) => {
            const meta = moduleMeta(r.module);
            return { key: `r${i}`, title: r.title, subtitle: r.subtitle, link: r.link, icon: meta.icon, accent: meta.accent, avatar: r.avatar, group: meta.label };
          })
        : [];
    return [...found, ...nav];
  }, [q, data, term]);

  useEffect(() => setActive(0), [rows.length, term]);
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !el) return;
    // Scroll only the list (scrollIntoView could move the page behind the overlay).
    const top = el.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top - 36;
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight + 8;
  }, [active]);

  if (!mounted) return null;

  const go = (row: Row | undefined) => {
    if (!row) return;
    close();
    navigate(row.link);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(rows[active]);
    }
  };

  let lastGroup = '';
  const searching = q.trim().length >= 2 && (isFetching || term !== q.trim());
  const noResults = q.trim().length >= 2 && !searching && rows.length === 0;

  return createPortal(
    <div className="fixed inset-0 z-[65] flex justify-center sm:items-start sm:p-6 sm:pt-[12vh]">
      <div className={cn('absolute inset-0 bg-overlay backdrop-blur-[3px]', closing ? 'animate-fade-out' : 'animate-fade-in')} onClick={close} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className={cn(
          'relative flex h-full w-full flex-col overflow-hidden bg-surface shadow-pop sm:h-auto sm:max-h-[70vh] sm:max-w-xl sm:rounded-2xl sm:border sm:border-border',
          closing ? 'animate-scale-out' : 'animate-scale-in',
        )}
      >
        <div className="pt-safe flex items-center gap-3 border-b border-border px-4">
          <Search size={19} className="shrink-0 text-subtle" />
          <input
            data-autofocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search events, lists, recipes, people…"
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-subtle focus:outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-activedescendant={rows[active] ? `sr-${rows[active].key}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <Spinner size={16} className="text-primary" />}
          <button type="button" onClick={close} className="text-sm font-semibold text-primary sm:hidden">
            Cancel
          </button>
          <kbd className="hidden rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted sm:inline">Esc</kbd>
        </div>
        <div ref={listRef} id="search-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 scrollbar-thin">
          {noResults && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-semibold text-fg">No results for “{q.trim()}”</p>
              <p className="mt-1 text-[13px] text-muted">Try a different word, or check the spelling.</p>
            </div>
          )}
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            const Icon = row.icon;
            return (
              <div key={row.key}>
                {header && <div className="px-3 pb-1.5 pt-3 text-[11px] font-bold uppercase tracking-wider text-subtle">{header}</div>}
                <button
                  id={`sr-${row.key}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  type="button"
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(row)}
                  className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors', i === active && 'bg-surface-2')}
                >
                  {row.avatar ? (
                    <Avatar user={row.avatar} size="md" />
                  ) : (
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl"
                      style={{ backgroundColor: `color-mix(in oklab, ${row.accent} 15%, transparent)`, color: row.accent }}
                    >
                      <Icon size={18} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-fg">{row.title}</span>
                    {row.subtitle && <span className="block truncate text-[13px] text-muted">{row.subtitle}</span>}
                  </span>
                  {i === active ? <CornerDownLeft size={15} className="shrink-0 text-subtle" /> : <ArrowRight size={15} className="shrink-0 text-transparent" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="hidden items-center gap-4 border-t border-border px-4 py-2.5 text-xs text-muted sm:flex">
          <span><kbd className="font-sans font-semibold">↑↓</kbd> navigate</span>
          <span><kbd className="font-sans font-semibold">↵</kbd> open</span>
          <span><kbd className="font-sans font-semibold">esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
