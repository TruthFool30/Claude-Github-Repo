import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { CalendarCheck2, LayoutGrid, Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Skeleton } from '../../ui';
import { ListTile } from './bits';
import { useLists, useMyTasks } from './data';
import { useAuth } from '../../lib/auth';
import { ListFormModal } from './ListFormModal';

/** Desktop side rail (≥1024px) next to a list / My tasks: quick switching between lists. */
export function Rail() {
  const q = useLists();
  const { user } = useAuth();
  const tasks = useMyTasks(user?.id).data;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const urgent = tasks ? tasks.overdue.length + tasks.today.length : 0;
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium transition',
      isActive ? 'bg-surface text-fg shadow-card ring-1 ring-border' : 'text-muted hover:bg-surface-2 hover:text-fg',
    );
  return (
    <nav aria-label="Lists" className="sticky top-24 flex max-h-[calc(100dvh-7rem)] flex-col gap-1 overflow-y-auto pr-1 scrollbar-thin">
      <NavLink to="/lists" end className={link}>
        <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-muted" aria-hidden><LayoutGrid size={16} /></span>
        All lists
      </NavLink>
      <NavLink to="/lists/my-tasks" className={link}>
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden><CalendarCheck2 size={16} /></span>
        <span className="flex-1">My tasks</span>
        {urgent > 0 && <span className="rounded-full bg-danger-soft px-1.5 text-[11px] font-bold text-danger-soft-fg tabular-nums">{urgent}</span>}
      </NavLink>
      <div className="mx-2.5 my-2 h-px bg-border" />
      {q.isPending
        ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mx-2.5 my-1.5 h-7" />)
        : q.data?.map((l) => (
            <NavLink key={l.id} to={`/lists/${l.id}`} className={link}>
              <ListTile icon={l.icon} color={l.color} size={32} />
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              {l.open_count > 0 && <span className="text-[12px] text-subtle tabular-nums">{l.open_count}</span>}
            </NavLink>
          ))}
      <button type="button" onClick={() => setOpen(true)} className="mt-1 flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-fg">
        <span className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border-strong" aria-hidden><Plus size={16} /></span>
        New list
      </button>
      <ListFormModal open={open} onClose={() => setOpen(false)} onSaved={(l) => navigate(`/lists/${l.id}`)} />
    </nav>
  );
}
