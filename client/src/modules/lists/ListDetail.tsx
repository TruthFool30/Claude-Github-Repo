import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff, LayoutList, ListRestart, Pencil, SearchX, Sparkles, Trash2, Rows3,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import type { Member } from '../../lib/types';
import { Button, EmptyState, IconButton, Menu, Skeleton, buttonClass, toast, useConfirm, type MenuEntry } from '../../ui';
import { AddBar } from './AddBar';
import { ItemRow } from './ItemRow';
import { ItemSheet } from './ItemSheet';
import { ListFormModal } from './ListFormModal';
import { ListTile, readPref, writePref } from './bits';
import { categoryEmoji, categoryRank } from './categories';
import { useList, useListActions } from './data';
import type { ListDetail as ListDetailT, ListItem } from './types';
import { useSortable } from './useSortable';

const SUGGESTIONS = ['Milk', 'Eggs', 'Bread', 'Bananas', 'Coffee', 'Toilet paper'];

/** Drop falsy entries and any divider that would be leading, trailing or doubled. */
function tidyMenu(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e === 'divider' && (out.length === 0 || out[out.length - 1] === 'divider')) continue;
    out.push(e);
  }
  while (out[out.length - 1] === 'divider') out.pop();
  return out;
}

/** Replace the slots a group occupies in the full order with the group's new order. */
function mergeOrder(all: ListItem[], groupNew: number[]): number[] {
  const inGroup = new Set(groupNew);
  const queue = [...groupNew];
  return [...all].sort((a, b) => a.position - b.position || a.id - b.id).map((i) => (inGroup.has(i.id) ? queue.shift()! : i.id));
}

export default function ListDetailPage() {
  const { id } = useParams();
  const listId = Number(id);
  const q = useList(listId);

  if (q.isPending) return <DetailSkeleton />;
  if (q.isError || !q.data) {
    const notFound = (q.error as { status?: number } | null)?.status === 404 || (q.error as { status?: number } | null)?.status === 400;
    return (
      <EmptyState
        icon={SearchX}
        accent="#30A46C"
        title={notFound ? 'List not found' : 'Couldn’t load this list'}
        description={notFound ? 'It may have been deleted by someone in your family.' : 'Check your connection and try again.'}
        action={
          notFound ? (
            <Link to="/lists" className={buttonClass('primary')}>Back to lists</Link>
          ) : (
            <Button onClick={() => q.refetch()}>Try again</Button>
          )
        }
      />
    );
  }
  return <DetailView key={listId} list={q.data} />;
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading list">
      <div className="mb-6 flex items-center gap-3">
        <Skeleton className="size-12 rounded-2xl" />
        <div className="flex-1">
          <Skeleton className="mb-2 h-6 w-48" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      </div>
      <Skeleton className="mb-5 h-14 w-full rounded-2xl" />
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <Skeleton circle className="size-6" />
          <Skeleton className="h-4" style={{ width: `${65 - (i % 3) * 14}%` }} />
        </div>
      ))}
    </div>
  );
}

function DetailView({ list }: { list: ListDetailT }) {
  const { user, members } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const actions = useListActions();
  const [params, setParams] = useSearchParams();
  const addRef = useRef<HTMLInputElement>(null);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [settling, setSettling] = useState<Set<number>>(() => new Set());
  const [highlight, setHighlight] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(() => readPref(`lists:done:${list.id}`, true));
  const [byAisle, setByAisle] = useState(() => readPref(`lists:aisles:${list.id}`, true));
  const [announce, setAnnounce] = useState('');
  const [celebrate, setCelebrate] = useState(false);
  const focusHandle = useRef<number | null>(null);
  useDocumentTitle(list.name);

  const memberById = useMemo(() => new Map<number, Member>(members.map((m) => [m.id, m])), [members]);
  const isShopping = list.type === 'shopping';
  const grouped = isShopping && byAisle;
  const items = list.items;
  const open = items.filter((i) => !i.done || settling.has(i.id));
  const done = items.filter((i) => i.done && !settling.has(i.id)).sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? ''));
  const pct = list.item_count ? Math.round((list.done_count / list.item_count) * 100) : 0;
  const sheetItem = items.find((i) => i.id === sheetId) ?? null;

  // Deep link: /lists/12?item=34 scrolls to and flashes the item.
  const target = Number(params.get('item')) || null;
  useEffect(() => {
    if (!target) return;
    const it = items.find((i) => i.id === target);
    if (!it) return;
    if (it.done && !showDone) setShowDone(true);
    setHighlight(target);
    requestAnimationFrame(() => {
      document.querySelector(`[data-item-id="${target}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const t = setTimeout(() => setHighlight(null), 2400);
    const next = new URLSearchParams(params);
    next.delete('item');
    setParams(next, { replace: true });
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, items.length]);

  // "/" or "n" focuses the add bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === '/' || e.key === 'n') {
        e.preventDefault();
        addRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const id = focusHandle.current;
    if (id == null) return;
    focusHandle.current = null;
    document.querySelector<HTMLElement>(`[data-item-id="${id}"] button[aria-label^="Reorder"]`)?.focus();
  });

  const toggle = useCallback(
    (item: ListItem, value: boolean) => {
      if (value) {
        setSettling((s) => new Set(s).add(item.id));
        setTimeout(() => setSettling((s) => { const n = new Set(s); n.delete(item.id); return n; }), 700);
        const remaining = list.items.filter((i) => !i.done && i.id !== item.id).length;
        if (remaining === 0 && list.items.length > 1) {
          setCelebrate(true);
          setTimeout(() => setCelebrate(false), 2600);
        }
      }
      actions.updateItem(list.id, item.id, { done: value }, user?.id).catch(() => {});
    },
    [actions, list.id, list.items, user?.id],
  );

  const reorderGroup = useCallback(
    (groupNew: number[], movedId?: number) => {
      void actions.reorder(list.id, mergeOrder(list.items, groupNew));
      if (movedId != null) {
        const it = list.items.find((i) => i.id === movedId);
        const at = groupNew.indexOf(movedId);
        setAnnounce(`Moved ${it?.text ?? 'item'} to position ${at + 1} of ${groupNew.length}`);
      }
    },
    [actions, list.id, list.items],
  );

  const setPrefDone = (v: boolean) => {
    setShowDone(v);
    writePref(`lists:done:${list.id}`, v);
  };

  const clearCompleted = async () => {
    const n = list.done_count;
    if (!n) return;
    const ok = await confirm({
      title: `Clear ${plural(n, 'completed item')}?`,
      message: 'They’ll be removed from the list for everyone.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    const res = await actions.bulkDone(list.id, 'clear-completed');
    if (res) toast.success(`Cleared ${plural(res.deleted ?? n, 'item')}`);
  };

  const uncheckAll = async () => {
    const res = await actions.bulkDone(list.id, 'uncheck-all');
    if (res) toast.success(`Unchecked ${plural(res.reset ?? 0, 'item')} — ready to reuse`);
  };

  const removeList = async () => {
    const ok = await confirm({
      title: `Delete “${list.name}”?`,
      message: `${plural(list.item_count, 'item')} will be deleted for everyone. This can’t be undone.`,
      confirmLabel: 'Delete list',
      danger: true,
    });
    if (!ok) return;
    // Leave first so this page doesn't refetch the list it is deleting.
    navigate('/lists');
    try {
      await actions.deleteList(list.id);
      toast.success(`Deleted ${list.name}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const duplicate = async () => {
    try {
      const copy = await actions.duplicateList(list.id);
      toast.success(`Created ${copy.name}`);
      navigate(`/lists/${copy.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Groups for rendering the open items.
  const groups = useMemo(() => {
    const sorted = [...open].sort((a, b) => a.position - b.position || a.id - b.id);
    if (!grouped) return [{ key: 'all', label: null as string | null, items: sorted }];
    const map = new Map<string, ListItem[]>();
    for (const it of sorted) {
      const c = it.category || 'Other';
      map.set(c, [...(map.get(c) ?? []), it]);
    }
    return [...map.entries()]
      .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]))
      .map(([key, its]) => ({ key, label: key, items: its }));
  }, [open, grouped]);

  const rowCommon = {
    listType: list.type,
    color: list.color,
    onToggle: toggle,
    onOpen: (it: ListItem) => setSheetId(it.id),
  };

  return (
    <div className="animate-fade-in">
      <header className="mb-4 flex items-start gap-3 sm:mb-5">
        <button
          type="button"
          aria-label="Back to lists"
          onClick={() => navigate('/lists')}
          className="-ml-2 mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg lg:hidden"
        >
          <ArrowLeft size={20} />
        </button>
        <span className="hidden sm:block"><ListTile icon={list.icon} color={list.color} size={48} /></span>
        <div className="min-w-0 flex-1">
          <h1 className="flex min-w-0 items-center gap-2 text-[24px] font-bold leading-tight tracking-tight text-fg sm:text-[28px]">
            <span className="sm:hidden" aria-hidden>{list.icon}</span>
            <span className="truncate">{list.name}</span>
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {list.item_count === 0
              ? 'No items yet'
              : list.open_count === 0
                ? `All ${list.item_count} done`
                : `${list.done_count} of ${list.item_count} done`}
            {list.overdue_count > 0 && <span className="font-medium text-danger"> · {list.overdue_count} overdue</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {list.can_manage && (
            <span className="hidden sm:block"><IconButton icon={Pencil} label="Edit list" variant="ghost" onClick={() => setEditOpen(true)} /></span>
          )}
          <Menu
            label="List actions"
            items={tidyMenu([
              list.can_manage && { label: 'Edit list', icon: Pencil, onSelect: () => setEditOpen(true) },
              { label: 'Duplicate', icon: Copy, onSelect: duplicate },
              isShopping && {
                label: byAisle ? 'Show in my order' : 'Group by aisle',
                icon: byAisle ? Rows3 : LayoutList,
                onSelect: () => {
                  setByAisle(!byAisle);
                  writePref(`lists:aisles:${list.id}`, !byAisle);
                },
              },
              { label: showDone ? 'Hide completed' : 'Show completed', icon: showDone ? EyeOff : Eye, onSelect: () => setPrefDone(!showDone) },
              'divider',
              list.can_manage && list.done_count > 0 && { label: 'Uncheck all', icon: ListRestart, onSelect: uncheckAll },
              list.can_manage && list.done_count > 0 && { label: 'Clear completed', icon: Sparkles, onSelect: clearCompleted },
              list.can_manage && { label: 'Delete list', icon: Trash2, danger: true, onSelect: removeList },
            ])}
          />
        </div>
      </header>

      {list.item_count > 0 && (
        <div
          className="mb-4 h-1.5 overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-label="List progress"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%`, backgroundColor: list.color }} />
        </div>
      )}

      <div className="sticky top-[calc(56px+env(safe-area-inset-top)+8px)] z-10 -mx-1 mb-4 px-1 lg:top-[72px]">
        <AddBar
          ref={addRef}
          listType={list.type}
          color={list.color}
          onAdd={(input) => void actions.addItem(list.id, input, user?.id).catch(() => {})}
        />
      </div>

      {celebrate && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold animate-scale-in" style={{ backgroundColor: `color-mix(in oklab, ${list.color} 14%, var(--surface))`, color: `color-mix(in oklab, ${list.color} 55%, var(--fg))` }} role="status">
          <span className="text-2xl" aria-hidden>🎉</span> Everything on {list.name} is done. Nice work!
        </div>
      )}

      {list.item_count === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-strong/70">
          <EmptyState
            compact
            icon={<span className="text-3xl">{list.icon}</span>}
            accent={list.color}
            title={isShopping ? 'Your cart is empty' : 'Nothing here yet'}
            description={isShopping ? 'Add what you need — we’ll sort it by aisle for you.' : 'Add the first item above. Tip: type @name to assign it.'}
            action={
              isShopping && (
                <div className="flex max-w-sm flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void actions.addItem(list.id, { text: s }, user?.id).catch(() => {})}
                      className="rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-fg transition hover:bg-surface-2 active:scale-95"
                    >
                      + {s}
                    </button>
                  ))}
                </div>
              )
            }
          />
        </div>
      ) : open.length === 0 && !celebrate ? (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-4 text-sm text-muted">
          <span className="text-2xl" aria-hidden>✨</span>
          <span>All done! {list.can_manage && list.type !== 'todo' ? 'Reusing this list? “Uncheck all” resets it.' : 'Add more above whenever you need.'}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label ?? 'Items'}>
              {g.label && (
                <h2 className="mb-1 flex items-center gap-2 px-1 text-[12px] font-bold uppercase tracking-wider text-subtle">
                  <span aria-hidden className="text-sm">{categoryEmoji(g.label)}</span>
                  {g.label}
                  <span className="font-semibold normal-case tracking-normal">· {g.items.length}</span>
                </h2>
              )}
              <SortableGroup
                items={g.items}
                memberById={memberById}
                settling={settling}
                highlight={highlight}
                sortable={list.can_manage}
                onReorder={(ids, moved) => {
                  if (moved != null) focusHandle.current = moved;
                  reorderGroup(ids, moved);
                }}
                {...rowCommon}
              />
            </section>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <section className="mt-6" aria-label="Completed items">
          <div className="flex items-center gap-2 px-1">
            <button
              type="button"
              onClick={() => setPrefDone(!showDone)}
              aria-expanded={showDone}
              className="inline-flex items-center gap-1.5 rounded-lg py-1.5 pr-2 text-[13px] font-semibold text-muted transition hover:text-fg"
            >
              <ChevronDown size={16} className={cn('transition-transform', !showDone && '-rotate-90')} aria-hidden />
              Completed · {done.length}
            </button>
            {list.can_manage && (
              <button type="button" onClick={clearCompleted} className="ml-auto rounded-lg px-2 py-1.5 text-[13px] font-semibold text-muted transition hover:bg-surface-2 hover:text-fg">
                Clear
              </button>
            )}
          </div>
          {showDone && (
            <ul className="mt-1 animate-fade-in flex flex-col divide-y divide-border/70 rounded-2xl border border-border bg-surface shadow-card">
              {done.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  assignee={it.assignee_id ? memberById.get(it.assignee_id) ?? null : null}
                  doneBy={it.done_by ? memberById.get(it.done_by) ?? null : null}
                  highlight={highlight === it.id}
                  reserveHandle={list.can_manage}
                  {...rowCommon}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <div aria-live="polite" className="sr-only">{announce}</div>

      <ItemSheet list={list} item={sheetItem} onClose={() => setSheetId(null)} />
      <ListFormModal open={editOpen} onClose={() => setEditOpen(false)} list={list} />
    </div>
  );
}

interface SortableGroupProps {
  items: ListItem[];
  memberById: Map<number, Member>;
  settling: Set<number>;
  highlight: number | null;
  listType: ListDetailT['type'];
  color: string;
  onToggle: (item: ListItem, done: boolean) => void;
  onOpen: (item: ListItem) => void;
  onReorder: (ids: number[], movedId?: number) => void;
  /** Viewer may reorder (grown-ups, or the list's creator). */
  sortable: boolean;
}

function SortableGroup({ items, memberById, settling, highlight, onReorder, sortable: canReorder, ...row }: SortableGroupProps) {
  const ids = items.map((i) => i.id);
  const movedRef = useRef<number | undefined>(undefined);
  const sortable = useSortable(ids, (next) => {
    onReorder(next, movedRef.current);
    movedRef.current = undefined;
  });
  const canSort = canReorder;
  return (
    <ul className="flex flex-col divide-y divide-border/70 rounded-2xl border border-border bg-surface shadow-card">
      {items.map((it) => (
        <ItemRow
          key={it.id}
          item={it}
          assignee={it.assignee_id ? memberById.get(it.assignee_id) ?? null : null}
          doneBy={it.done_by ? memberById.get(it.done_by) ?? null : null}
          settling={settling.has(it.id)}
          highlight={highlight === it.id}
          dragging={sortable.draggingId === it.id}
          rowRef={sortable.register(it.id)}
          handleProps={canSort && it.id > 0 ? sortable.handleProps(it.id) : null}
          onMoveKey={(item, delta) => {
            movedRef.current = item.id;
            if (!sortable.moveBy(item.id, delta)) movedRef.current = undefined;
          }}
          {...row}
        />
      ))}
    </ul>
  );
}
