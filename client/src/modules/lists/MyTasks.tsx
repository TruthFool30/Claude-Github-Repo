import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft, CalendarCheck2, PartyPopper } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { Button, Checkbox, EmptyState, Skeleton, toast } from '../../ui';
import { PeoplePicker } from './PeoplePicker';
import { DueChip } from './bits';
import { useListActions, useMyTasks } from './data';
import type { MyTasks, TaskItem } from './types';

const GROUPS: Array<{ key: keyof Pick<MyTasks, 'overdue' | 'today' | 'upcoming' | 'someday'>; label: string; dot: string }> = [
  { key: 'overdue', label: 'Overdue', dot: 'bg-danger' },
  { key: 'today', label: 'Today', dot: 'bg-warning' },
  { key: 'upcoming', label: 'Upcoming', dot: 'bg-info' },
  { key: 'someday', label: 'No due date', dot: 'bg-border-strong' },
];

export function TaskRow({ task, onToggle, compact }: { task: TaskItem; onToggle: (t: TaskItem, v: boolean) => void; compact?: boolean }) {
  const navigate = useNavigate();
  return (
    <li className={cn('group flex items-center gap-2 rounded-xl transition-opacity duration-300', task.done && 'opacity-60')}>
      <Checkbox
        shape="circle"
        size={compact ? 'md' : 'lg'}
        color={task.list_color}
        checked={task.done}
        className="-m-1 p-2.5"
        aria-label={task.done ? `Mark “${task.text}” as not done` : `Mark “${task.text}” as done`}
        onChange={(v) => onToggle(task, v)}
      />
      <button
        type="button"
        onClick={() => navigate(`/lists/${task.list_id}?item=${task.id}`)}
        className="flex min-w-0 flex-1 flex-col items-start rounded-lg py-2 pl-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn('max-w-full truncate font-medium text-fg', compact ? 'text-sm' : 'text-[15px]', task.done && 'text-subtle line-through')}>{task.text}</span>
        <span className="mt-0.5 flex max-w-full flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <span className="inline-flex max-w-[12rem] items-center gap-1 truncate">
            <span aria-hidden>{task.list_icon}</span>
            <span className="truncate">{task.list_name}</span>
          </span>
          {task.due_date && <DueChip due={task.due_date} done={task.done} />}
        </span>
      </button>
    </li>
  );
}

export function useTaskToggle() {
  const { user } = useAuth();
  const { updateItem } = useListActions();
  const toggle = (t: TaskItem, v: boolean) => {
    if (v) {
      toast.success(`Done: ${t.text}`, {
        id: `task-${t.id}`,
        action: { label: 'Undo', onClick: () => void updateItem(t.list_id, t.id, { done: false }, user?.id).catch(() => {}) },
      });
    }
    void updateItem(t.list_id, t.id, { done: v }, user?.id).catch(() => {});
  };
  return { toggle };
}

export default function MyTasksPage() {
  const { user, members } = useAuth();
  const [who, setWho] = useState<number | null>(user?.id ?? null);
  const q = useMyTasks(who);
  const { toggle } = useTaskToggle();
  const navigate = useNavigate();
  const isMe = who === user?.id;
  const person = members.find((m) => m.id === who);
  useDocumentTitle(isMe ? 'My tasks' : `${firstName(person?.name)}’s tasks`);
  const total = q.data ? GROUPS.reduce((n, g) => n + q.data[g.key].length, 0) : 0;

  return (
    <div className="animate-fade-in">
      <header className="mb-5 flex items-start gap-3">
        <button
          type="button"
          aria-label="Back to lists"
          onClick={() => navigate('/lists')}
          className="-ml-2 mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg lg:hidden"
        >
          <ArrowLeft size={20} />
        </button>
        <span className="hidden size-12 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary sm:flex" aria-hidden>
          <CalendarCheck2 size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[24px] font-bold leading-tight tracking-tight text-fg sm:text-[28px]">
            {isMe ? 'My tasks' : `${firstName(person?.name)}’s tasks`}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {q.data
              ? total === 0
                ? 'Nothing assigned right now'
                : `${total} open · ${q.data.overdue.length} overdue · ${q.data.today.length} due today`
              : 'Everything assigned across your lists'}
          </p>
        </div>
      </header>

      <div className="mb-5 overflow-x-auto pb-1 scrollbar-none">
        <PeoplePicker value={who} onChange={(id) => id && setWho(id)} allowEmpty={false} aria-label="Show tasks for" nowrap className="w-max px-1 py-1" />
      </div>

      {q.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading tasks">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <Skeleton circle className="size-6" />
              <div className="flex-1">
                <Skeleton className="mb-1.5 h-4" style={{ width: `${60 - (i % 3) * 10}%` }} />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState compact title="Couldn’t load tasks" description="Check your connection and try again." action={<Button onClick={() => q.refetch()}>Try again</Button>} />
      ) : total === 0 ? (
        <EmptyState
          icon={PartyPopper}
          accent="#30A46C"
          title={isMe ? 'You’re all caught up' : `${firstName(person?.name)} is all caught up`}
          description="Tasks assigned in to-do lists show up here, sorted by when they’re due."
          action={<Link to="/lists" className="text-sm font-semibold text-primary hover:underline">Browse lists</Link>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {GROUPS.filter((g) => q.data[g.key].length > 0).map((g) => (
            <section key={g.key} className="rounded-2xl border border-border bg-surface p-3 shadow-card sm:p-4" aria-label={g.label}>
              <h2 className="mb-1 flex items-center gap-2 px-1 text-[13px] font-bold text-fg">
                <span className={cn('size-2 rounded-full', g.dot)} aria-hidden />
                {g.label}
                <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-semibold text-muted tabular-nums">{q.data[g.key].length}</span>
              </h2>
              <ul className="flex flex-col">
                {q.data[g.key].map((t) => (
                  <TaskRow key={t.id} task={t} onToggle={toggle} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
