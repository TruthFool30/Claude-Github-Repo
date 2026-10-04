import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { CalendarCheck2, ChevronRight, Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtRelative, plural } from '../../lib/format';
import { Avatar, Button, EmptyState, Fab, Menu, PageHeader, SegmentedControl, Skeleton, toast, useConfirm } from '../../ui';
import mod from './index';
import { ListTile, ProgressRing } from './bits';
import { TYPE_META } from './categories';
import { useListActions, useLists, useMyTasks } from './data';
import { ListFormModal } from './ListFormModal';
import { TaskRow, useTaskToggle } from './MyTasks';
import type { ListSummary, ListType } from './types';

type Filter = 'all' | ListType;

const QUICK_STARTS: Array<{ name: string; type: ListType; icon: string; color: string }> = [
  { name: 'Groceries', type: 'shopping', icon: '🛒', color: '#30A46C' },
  { name: 'Chores', type: 'todo', icon: '🧹', color: '#F76B15' },
  { name: 'Packing list', type: 'other', icon: '🧳', color: '#0090FF' },
];

export default function Overview() {
  const q = useLists();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [createOpen, setCreateOpen] = useState<ListType | null>(null);
  const [editing, setEditing] = useState<ListSummary | null>(null);
  const lists = q.data ?? [];
  const shown = filter === 'all' ? lists : lists.filter((l) => l.type === filter);
  const openTotal = lists.reduce((n, l) => n + l.open_count, 0);
  const count = (t: ListType) => lists.filter((l) => l.type === t).length;
  const { createList } = useListActions();
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const quickStart = async (t: (typeof QUICK_STARTS)[number]) => {
    setQuickBusy(t.name);
    try {
      const l = await createList(t);
      navigate(`/lists/${l.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setQuickBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title={mod.label}
        subtitle={q.data ? (lists.length ? `${plural(lists.length, 'list')} · ${plural(openTotal, 'open item')}` : mod.description) : mod.description}
        icon={mod.icon}
        accent={mod.accent}
        actions={
          lists.length > 0 && (
            <span className="hidden sm:block">
              <Button icon={Plus} onClick={() => setCreateOpen('shopping')}>New list</Button>
            </span>
          )
        }
      />

      <div>
        <div className="min-w-0">
          {lists.length > 0 && (
            <div className="mb-5">
              <MyTasksCard />
            </div>
          )}

          {lists.length > 0 && (
            <div className="mb-4 overflow-x-auto scrollbar-none">
              <SegmentedControl
                aria-label="Filter lists"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `All ${lists.length}` },
                  { value: 'shopping', label: `Shopping ${count('shopping')}` },
                  { value: 'todo', label: `To-dos ${count('todo')}` },
                  { value: 'other', label: `Other ${count('other')}` },
                ]}
              />
            </div>
          )}

          {q.isPending ? (
            <div className="grid gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Loading lists">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="rounded-2xl border border-border bg-surface p-4 shadow-card">
                  <div className="mb-4 flex items-center gap-3">
                    <Skeleton className="size-11 rounded-2xl" />
                    <div className="flex-1">
                      <Skeleton className="mb-2 h-4 w-2/3" />
                      <Skeleton className="h-3 w-1/3" />
                    </div>
                    <Skeleton circle className="size-11" />
                  </div>
                  <Skeleton className="mb-2 h-3 w-4/5" />
                  <Skeleton className="h-3 w-3/5" />
                </div>
              ))}
            </div>
          ) : q.isError ? (
            <EmptyState compact title="Couldn’t load your lists" description="Check your connection and try again." action={<Button onClick={() => q.refetch()}>Try again</Button>} />
          ) : lists.length === 0 ? (
            <EmptyState
              icon={mod.icon}
              accent={mod.accent}
              title="Start your first list"
              description="Groceries, chores, packing for the trip — share it with the family and check things off together."
              action={
                <div className="flex flex-col items-center gap-4">
                  <p className="text-[13px] font-medium text-muted">Start with one tap</p>
                  <div className="grid w-full max-w-md grid-cols-3 gap-2.5">
                    {QUICK_STARTS.map((t) => (
                      <button
                        key={t.name}
                        type="button"
                        disabled={quickBusy !== null}
                        onClick={() => quickStart(t)}
                        className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface px-2 py-4 text-[13px] font-semibold text-fg shadow-card transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift active:scale-95 disabled:opacity-60"
                      >
                        <ListTile icon={t.icon} color={t.color} size={44} />
                        {quickBusy === t.name ? 'Creating…' : t.name}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={() => setCreateOpen('shopping')} className="text-sm font-semibold text-primary hover:underline">
                    Or start from scratch
                  </button>
                </div>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState
              compact
              icon={<span className="text-3xl">{TYPE_META[filter as ListType].icon}</span>}
              accent={TYPE_META[filter as ListType].color}
              title={`No ${TYPE_META[filter as ListType].plural.toLowerCase()} lists yet`}
              action={<Button size="sm" icon={Plus} onClick={() => setCreateOpen(filter as ListType)}>New {TYPE_META[filter as ListType].label.toLowerCase()} list</Button>}
            />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {shown.map((l, i) => (
                <li key={l.id} className="animate-scale-in" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                  <ListCard list={l} onEdit={() => setEditing(l)} />
                </li>
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => setCreateOpen(filter === 'all' ? 'shopping' : filter)}
                  className="flex h-full min-h-[120px] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border text-sm font-semibold text-muted transition hover:border-border-strong hover:bg-surface hover:text-fg"
                >
                  <span className="flex size-10 items-center justify-center rounded-full bg-surface-2"><Plus size={20} aria-hidden /></span>
                  New list
                </button>
              </li>
            </ul>
          )}
        </div>

      </div>

      {lists.length > 0 && <Fab label="New list" onClick={() => setCreateOpen('shopping')} />}
      <ListFormModal
        open={createOpen !== null}
        initialType={createOpen ?? 'shopping'}
        onClose={() => setCreateOpen(null)}
        onSaved={(l) => navigate(`/lists/${l.id}`)}
      />
      <ListFormModal open={!!editing} list={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ListCard({ list, onEdit }: { list: ListSummary; onEdit: () => void }) {
  const { members } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { deleteList, duplicateList } = useListActions();
  const assignees = list.assignee_ids.map((id) => members.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  const extra = list.open_count - list.preview.length;

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${list.name}”?`,
      message: `${plural(list.item_count, 'item')} will be deleted for everyone. This can’t be undone.`,
      confirmLabel: 'Delete list',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteList(list.id);
      toast.success(`Deleted ${list.name}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <article
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-card transition-all duration-200 focus-within:ring-4 focus-within:ring-ring hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift"
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: list.color }} aria-hidden />
      <div className="flex items-start gap-3">
        <ListTile icon={list.icon} color={list.color} size={44} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[16px] font-semibold tracking-tight text-fg">
            <Link to={`/lists/${list.id}`} className="outline-none after:absolute after:inset-0 after:content-['']">
              {list.name}
            </Link>
          </h3>
          <p className="text-[13px] text-muted">
            {TYPE_META[list.type].label} · {list.item_count ? `${list.done_count}/${list.item_count} done` : 'Empty'}
          </p>
        </div>
        <ProgressRing done={list.done_count} total={list.item_count} color={list.color} />
        <div className="relative z-10 -mr-1.5 -mt-1">
          <Menu
            label={`Actions for ${list.name}`}
            items={[
              list.can_manage && { label: 'Edit', icon: Pencil, onSelect: onEdit },
              {
                label: 'Duplicate',
                icon: Copy,
                onSelect: async () => {
                  try {
                    const c = await duplicateList(list.id);
                    toast.success(`Created ${c.name}`);
                    navigate(`/lists/${c.id}`);
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                },
              },
              list.can_manage && 'divider',
              list.can_manage && { label: 'Delete', icon: Trash2, danger: true, onSelect: remove },
            ]}
          />
        </div>
      </div>

      <ul className="mt-3 flex flex-1 flex-col gap-1.5 text-[13.5px]">
        {list.preview.length === 0 ? (
          <li className="text-muted">{list.item_count ? 'All done 🎉' : 'Nothing yet — tap to add the first item'}</li>
        ) : (
          list.preview.slice(0, 3).map((t, i) => (
            <li key={i} className="flex min-w-0 items-center gap-2 text-fg/85">
              <span className="size-3.5 shrink-0 rounded-full border-2" style={{ borderColor: `color-mix(in oklab, ${list.color} 55%, var(--border-strong))` }} aria-hidden />
              <span className="truncate">{t}</span>
            </li>
          ))
        )}
        {extra > 0 && list.preview.length >= 3 && <li className="pl-5.5 text-[12.5px] text-subtle">+{extra} more</li>}
      </ul>

      <div className="mt-3 flex items-center gap-2 border-t border-border/70 pt-3 text-[12px] text-muted">
        {assignees.length > 0 && (
          <span className="flex items-center" aria-label={`Assigned: ${assignees.map((m) => m.name).join(', ')}`}>
            {assignees.slice(0, 3).map((m, i) => (
              <span key={m.id} className={cn('rounded-full ring-2 ring-surface', i > 0 && '-ml-1.5')}>
                <Avatar user={m} size="sm" />
              </span>
            ))}
            {assignees.length > 3 && (
              <span className="-ml-1.5 flex size-7 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted ring-2 ring-surface">
                +{assignees.length - 3}
              </span>
            )}
          </span>
        )}
        {list.overdue_count > 0 && <span className="whitespace-nowrap rounded-full bg-danger-soft px-2 py-0.5 font-semibold text-danger-soft-fg">{list.overdue_count} overdue</span>}
        {list.due_today_count > 0 && <span className="whitespace-nowrap rounded-full bg-warning-soft px-2 py-0.5 font-semibold text-warning-soft-fg">{list.due_today_count} today</span>}
        <span className="ml-auto min-w-0 truncate text-right text-subtle">Updated {fmtRelative(list.updated_at)}</span>
      </div>
    </article>
  );
}

/** "My tasks" card: overdue + today with quick check-off. */
export function MyTasksCard({ compact }: { compact?: boolean }) {
  const { user } = useAuth();
  const q = useMyTasks(user?.id);
  const { toggle } = useTaskToggle();
  const urgent = q.data ? [...q.data.overdue, ...q.data.today] : [];
  const upcoming = q.data?.upcoming.length ?? 0;
  const shownTasks = urgent.slice(0, compact ? 2 : 4);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card" aria-label="My tasks">
      <Link
        to="/lists/my-tasks"
        className="flex items-center gap-3 px-4 pb-2 pt-4 transition hover:bg-surface-2/50"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary" aria-hidden>
          <CalendarCheck2 size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-fg">My tasks</span>
          <span className="block truncate text-[13px] text-muted">
            {q.isPending
              ? 'Loading…'
              : urgent.length
                ? [q.data!.overdue.length && `${q.data!.overdue.length} overdue`, q.data!.today.length && `${q.data!.today.length} due today`].filter(Boolean).join(' · ')
                : upcoming
                  ? `Nothing urgent · ${upcoming} coming up`
                  : 'You’re all caught up 🎉'}
          </span>
        </span>
        <ChevronRight size={18} className="text-subtle" aria-hidden />
      </Link>
      {q.isPending ? (
        <div className="px-4 pb-4 pt-1"><Skeleton className="h-4 w-3/4" /></div>
      ) : shownTasks.length > 0 ? (
        <ul className={cn('grid gap-x-4 px-3 pb-2 sm:grid-cols-2', compact && 'pb-1')}>
          {shownTasks.map((t) => <TaskRow key={t.id} task={t} onToggle={toggle} compact />)}
          {urgent.length > shownTasks.length && (
            <li className="px-2 pb-1 text-[12.5px] text-subtle sm:col-span-2">
              <NavLink to="/lists/my-tasks" className="hover:text-fg">+{urgent.length - shownTasks.length} more</NavLink>
            </li>
          )}
        </ul>
      ) : (
        <div className="pb-2" />
      )}
    </section>
  );
}
