// Savings goals (family + kids) and kids' allowances.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Banknote, CalendarClock, CalendarDays, HandCoins, Minus, Pencil, PiggyBank, Plus, Repeat, Settings2, Trash2, Trophy } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth, useMember } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtDate, fmtRelative, plural, toDate } from '../../lib/format';
import type { Member } from '../../lib/types';
import {
  Avatar, Badge, Button, Card, ColorPicker, EmptyState, Fab, Field, IconButton, Input, Menu, MemberPicker, Modal, SegmentedControl, Select,
  Skeleton, SkeletonCard, Switch, toast, useConfirm,
} from '../../ui';
import {
  amountToInput, currentMonth, keys, localDay, monthLabel, nextAuto, parseAmount, useAllowances, useCanManage, useGoal, useGoals, useMoney, type Allowance, type Goal,
} from './api';
import { MoneyInput, Progress, Ring } from './shared';
import mod from './index';

const EMOJIS = ['🎯', '🏖️', '🏕️', '✈️', '🚲', '🚀', '🎮', '🧸', '🎸', '💻', '🚗', '🏠', '🛟', '🎓', '🐶', '🎁'];

function monthsUntil(date: string | null) {
  const d = toDate(date);
  if (!d) return null;
  const now = new Date();
  return Math.max(0, (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth());
}

/** Target month already over (and not reached): automatic contributions have stopped. */
const pastDate = (g: Goal) => !g.completed_at && !!g.target_date && g.target_date.slice(0, 7) < currentMonth();

/** "this month" / "on Nov 1" for a next-contribution month. */
const whenLabel = (n: { month: string; thisMonth: boolean }) => (n.thisMonth ? 'this month' : `on ${fmtDate(`${n.month}-01`, 'MMM d')}`);

function AutoBadge({ g }: { g: Goal }) {
  const { fmt } = useMoney();
  const next = g.auto_monthly ? nextAuto(g) : null;
  if (!next) return null;
  return (
    <Badge tone="primary" className="max-w-full">
      <Repeat size={11} aria-hidden /><span className="sr-only">Saves automatically: next</span>
      <span aria-hidden>Auto ·</span> {fmt(next.amount)} {whenLabel(next)}
    </Badge>
  );
}

export function useCanEditGoal() {
  const { user } = useAuth();
  const canManage = useCanManage();
  return (g: Goal) => canManage || g.owner_id === user?.id || g.created_by === user?.id;
}

export function GoalCard({ g, onOpen, compact }: { g: Goal; onOpen: (g: Goal) => void; compact?: boolean }) {
  const { fmt } = useMoney();
  const owner = useMember(g.owner_id);
  const ratio = g.target > 0 ? g.saved / g.target : 0;
  const left = Math.max(0, g.target - g.saved);
  const months = monthsUntil(g.target_date);
  const perMonth = months && left > 0 && !g.auto_monthly ? left / months : null;
  const done = !!g.completed_at;
  const past = pastDate(g);
  return (
    <Card interactive padding={compact ? 'sm' : 'md'} onClick={() => onOpen(g)} className="group relative overflow-hidden">
      <button type="button" className="absolute inset-0 z-10 rounded-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring" aria-label={`Open goal ${g.name}`} onClick={(e) => { e.stopPropagation(); onOpen(g); }} />
      <div className="flex items-center gap-4">
        <Ring ratio={ratio} color={done ? 'var(--success)' : g.color} size={compact ? 56 : 68} stroke={compact ? 6 : 7}>
          <span className={compact ? 'text-xl' : 'text-2xl'} aria-hidden>{g.emoji || '🎯'}</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-[15px] font-semibold text-fg" title={g.name}>{g.name}</h3>
            {done ? (
              <Badge tone="success"><Trophy size={11} /> Reached</Badge>
            ) : (
              <span className="ml-auto shrink-0 text-xs font-semibold text-muted tabular">{Math.min(100, Math.round(ratio * 100))}%</span>
            )}
          </div>
          <div className="mt-0.5 truncate whitespace-nowrap text-[13px] text-muted tabular">
            <span className="font-semibold text-fg">{fmt(g.saved)}</span> of {fmt(g.target)}
          </div>
          {compact && !done && (g.auto_monthly || past) && (
            <div className="mt-1 flex">{past ? <Badge tone="warning"><CalendarClock size={11} aria-hidden />Past its date</Badge> : <AutoBadge g={g} />}</div>
          )}
          {!compact && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {owner ? (
                <span className="inline-flex items-center gap-1.5"><Avatar user={owner} size="xs" />{firstName(owner.name)}'s goal</span>
              ) : (
                <span>Family goal</span>
              )}
              {g.target_date && !done && (past ? (
                <span className="inline-flex items-center gap-1 font-medium text-warning-soft-fg"><CalendarClock size={12} aria-hidden />Past its date · {fmtDate(g.target_date, 'MMM yyyy')}</span>
              ) : (
                <span className="inline-flex items-center gap-1"><CalendarDays size={12} aria-hidden />by {fmtDate(g.target_date, 'MMM yyyy')}{perMonth ? ` · ${fmt(perMonth)}/mo` : ''}</span>
              ))}
              {!done && <AutoBadge g={g} />}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function GoalForm({ open, onClose, editing }: { open: boolean; onClose: () => void; editing?: Goal | null }) {
  const hintId = useId();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = useCanManage();
  const { currency, fmt } = useMoney();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🎯');
  const [color, setColor] = useState('#12A594');
  const [target, setTarget] = useState('');
  const [saved, setSaved] = useState('');
  const [owner, setOwner] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [auto, setAuto] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setEmoji(editing?.emoji ?? '🎯');
    setColor(editing?.color ?? '#12A594');
    setTarget(editing ? amountToInput(editing.target) : '');
    setSaved('');
    setOwner(editing ? editing.owner_id : canManage ? null : user?.id ?? null);
    setDate(editing?.target_date ?? '');
    setAuto(editing?.auto_monthly ?? false);
    setErrors({});
  }, [open, editing, canManage, user?.id]);

  // Live preview of the monthly amount (the server makes this month's contribution as soon as it's saved).
  const preview = date ? nextAuto({
    target: parseAmount(target) ?? 0, saved: editing ? editing.saved : parseAmount(saved) ?? 0, target_date: date, completed_at: null,
    auto_last_month: editing?.auto_last_month ?? null,
  }) : null;
  const autoPreview = !date
    ? "Set a target date first: the amount is what's left, spread over the months until then."
    : date.slice(0, 7) < currentMonth()
      ? 'The target date has passed, so nothing would be added.'
      : !preview
        ? (parseAmount(target) ? 'Already at the target.' : 'Enter a target to see the monthly amount.')
        : `≈ ${fmt(preview.amount)}/month until ${fmtDate(date, 'MMM yyyy')}, ${editing?.auto_monthly
          ? `next ${whenLabel(preview)}`
          : `first ${preview.thisMonth ? 'one this month, as soon as you save' : whenLabel(preview)}`}. Adjusts itself when money is added or taken out.`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = parseAmount(target);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'What are you saving for?';
    if (!t) errs.target = 'Enter a target amount';
    if (saved && parseAmount(saved) === null) errs.saved = 'Enter a valid amount';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), emoji, color, target: t, owner_id: owner, target_date: date || null, auto_monthly: auto && !!date };
      if (!editing && saved) body.saved = parseAmount(saved);
      const res = editing ? await api.patch<Goal>(`/budget/goals/${editing.id}`, body) : await api.post<Goal>('/budget/goals', body);
      qc.invalidateQueries({ queryKey: keys.all });
      // This month's automatic contribution, if saving just made one: the month became claimed and the newest entry is automatic.
      const made = res.entries?.[0];
      // (an older automatic entry from a previous month doesn't count; created_at is UTC, so a contribution made in the
      // first hours of a month east of UTC may skip the toast — never the other way round)
      const fresh = made?.source === 'auto' && !!res.auto_last_month && res.auto_last_month !== editing?.auto_last_month
        && made.created_at.slice(0, 7) === res.auto_last_month;
      toast.success(editing ? 'Goal updated' : 'Goal created — happy saving!', fresh ? { description: `${fmt(made.amount)} put aside for ${monthLabel(currentMonth())}` } : undefined);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={editing ? 'Edit goal' : 'New savings goal'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="budget-goal-form" loading={busy}>{editing ? 'Save' : 'Create goal'}</Button></>}
    >
      <form id="budget-goal-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Goal" error={errors.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. New bike, Summer trip" autoFocus={!editing} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold text-fg">Emoji</legend>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Emoji">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={emoji === e}
                aria-label={e}
                onClick={() => setEmoji(e)}
                className={cn('flex size-10 items-center justify-center rounded-xl border text-xl transition active:scale-90', emoji === e ? 'border-primary bg-primary-soft' : 'border-transparent hover:bg-surface-2')}
              >
                {e}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="grid [&>*]:min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Target" error={errors.target} required>
            <MoneyInput size="md" value={target} onChange={setTarget} currency={currency} invalid={!!errors.target} />
          </Field>
          {!editing && (
            <Field label="Already saved" error={errors.saved}>
              <MoneyInput size="md" value={saved} onChange={setSaved} currency={currency} placeholder="0" invalid={!!errors.saved} name="saved" />
            </Field>
          )}
          <Field label="Target date" hint="Optional">
            <Input type="date" value={date} min="1970-01-01" max="2100-12-31" onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <div className="rounded-2xl border border-border p-3.5">
          <Switch checked={auto && !!date} onChange={setAuto} disabled={!date} label="Contribute automatically each month" aria-describedby={hintId} />
          <p id={hintId} className="mt-1 pr-16 text-xs text-muted">{autoPreview}</p>
        </div>
        {canManage && (
          <Field label="Whose goal?" hint="Leave empty for a family goal">
            <MemberPicker value={owner} onChange={setOwner} />
          </Field>
        )}
        <Field label="Color">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
      </form>
    </Modal>
  );
}

function ContributeDialog({ goal, mode, onClose }: { goal: Goal | null; mode: 'add' | 'withdraw'; onClose: () => void }) {
  const qc = useQueryClient();
  const { currency, fmt } = useMoney();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (goal) {
      setAmount('');
      setNote('');
      setError('');
    }
  }, [goal, mode]);
  if (!goal) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    if (!n) return setError('Enter an amount greater than zero');
    if (mode === 'withdraw' && n > goal.saved) return setError(`There's only ${fmt(goal.saved)} saved`);
    setBusy(true);
    const delta = mode === 'add' ? n : -n;
    // Optimistic: bump the saved amount on the goals list right away.
    const prev = qc.getQueryData<Goal[]>(keys.goals);
    qc.setQueryData<Goal[]>(keys.goals, (old) => old?.map((g) => (g.id === goal.id ? { ...g, saved: g.saved + delta } : g)));
    try {
      const res = await api.post<Goal>(`/budget/goals/${goal.id}/entries`, { amount: delta, note: note.trim() || null });
      qc.setQueryData(keys.goal(goal.id), res);
      if (res.completed_at && !goal.completed_at) toast.success(`Goal reached: ${goal.name}! 🎉`, { description: 'Time to celebrate.' });
      else toast.success(mode === 'add' ? `${fmt(n)} added to ${goal.name}` : `${fmt(n)} taken out of ${goal.name}`);
      onClose();
    } catch (err) {
      qc.setQueryData(keys.goals, prev);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: keys.all });
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={mode === 'add' ? `Add to ${goal.name}` : `Take out of ${goal.name}`}
      description={`${fmt(goal.saved)} saved of ${fmt(goal.target)}`}
      icon={<span className="text-2xl">{goal.emoji || '🎯'}</span>}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="budget-contrib-form" loading={busy}>{mode === 'add' ? 'Add money' : 'Take out'}</Button></>}
    >
      <form id="budget-contrib-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Amount" error={error}>
          <MoneyInput value={amount} onChange={setAmount} currency={currency} autoFocus invalid={!!error} ariaLabel="Amount" />
        </Field>
        {mode === 'add' && (
          <div className="flex flex-wrap gap-2">
            {[5, 10, 20, 50].map((v) => (
              <Button key={v} size="sm" variant="secondary" onClick={() => setAmount(String(v))}>+{fmt(v)}</Button>
            ))}
          </div>
        )}
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} placeholder={mode === 'add' ? 'e.g. Birthday money' : 'What was it for?'} />
        </Field>
      </form>
    </Modal>
  );
}

function GoalDetail({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { fmt } = useMoney();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canEdit = useCanEditGoal();
  const { data: g, isLoading } = useGoal(id);
  const owner = useMember(g?.owner_id);
  const [contrib, setContrib] = useState<'add' | 'withdraw' | null>(null);
  const [editing, setEditing] = useState(false);
  const { members } = useAuth();
  const who = (uid: number | null) => members.find((m) => m.id === uid);

  const editable = g ? canEdit(g) : false;
  const canDeposit = editable;

  const remove = async () => {
    if (!g) return;
    if (!(await confirm({ title: `Delete “${g.name}”?`, message: 'The goal and its history will be removed.', confirmLabel: 'Delete goal', danger: true }))) return;
    try {
      await api.del(`/budget/goals/${g.id}`);
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success('Goal deleted');
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const removeEntry = async (entryId: number) => {
    if (!g) return;
    try {
      const res = await api.del<Goal>(`/budget/goals/${g.id}/entries/${entryId}`);
      qc.setQueryData(keys.goal(g.id), res);
      qc.invalidateQueries({ queryKey: keys.goals });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const ratio = g && g.target > 0 ? g.saved / g.target : 0;
  const next = g?.auto_monthly ? nextAuto(g) : null;
  return (
    <>
      <Modal
        open={!!id && !contrib && !editing}
        onClose={onClose}
        size="md"
        title={g ? <span className="inline-flex items-center gap-2"><span aria-hidden>{g.emoji || '🎯'}</span>{g.name}</span> : 'Goal'}
        footer={
          g && canDeposit ? (
            <>
              {editable && g.saved > 0 && <Button variant="secondary" icon={Minus} onClick={() => setContrib('withdraw')}>Take out</Button>}
              <Button icon={Plus} onClick={() => setContrib('add')}>Add money</Button>
            </>
          ) : undefined
        }
      >
        {isLoading || !g ? (
          <div className="flex flex-col gap-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-4 w-2/3" /></div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-5 rounded-2xl p-4" style={{ backgroundColor: `color-mix(in oklab, ${g.color} 10%, var(--surface))` }}>
              <Ring ratio={ratio} color={g.completed_at ? 'var(--success)' : g.color} size={92} stroke={9}>
                <span className="text-lg font-bold text-fg tabular">{Math.min(100, Math.round(ratio * 100))}%</span>
              </Ring>
              <div className="min-w-0 flex-1">
                <div className="text-2xl font-bold tracking-tight text-fg tabular">{fmt(g.saved)}</div>
                <div className="text-sm text-muted">saved of {fmt(g.target)}</div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                  {owner ? <span className="inline-flex items-center gap-1.5"><Avatar user={owner} size="xs" />{firstName(owner.name)}</span> : <span>Family goal</span>}
                  {g.completed_at ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-success-soft-fg"><Trophy size={12} />Reached {fmtRelative(g.completed_at)}</span>
                  ) : (
                    <span>{fmt(Math.max(0, g.target - g.saved))} to go{g.target_date ? ` · by ${fmtDate(g.target_date, 'MMM d, yyyy')}` : ''}</span>
                  )}
                </div>
                {!g.completed_at && (pastDate(g) ? (
                  <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-warning-soft-fg">
                    <CalendarClock size={13} className="mt-px shrink-0" aria-hidden />
                    {g.auto_monthly ? 'Past its date, so automatic contributions have stopped. Pick a later date to keep going.' : 'Past its target date.'}
                  </p>
                ) : next && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-primary-soft-fg">
                    <Repeat size={13} className="mt-px shrink-0" aria-hidden />
                    Saving automatically: next {fmt(next.amount)} {whenLabel(next)}, recalculated each month.
                  </p>
                ))}
              </div>
              {editable && (
                <Menu
                  label="Goal actions"
                  items={[
                    { label: 'Edit goal', icon: Pencil, onSelect: () => setEditing(true) },
                    { label: 'Delete goal', icon: Trash2, danger: true, onSelect: remove },
                  ]}
                />
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-subtle">History</h3>
              {!g.entries?.length ? (
                <p className="py-4 text-center text-sm text-muted">No money added yet — every bit counts!</p>
              ) : (
                <ul className="divide-y divide-border rounded-2xl border border-border">
                  {g.entries.map((e) => {
                    const m = who(e.user_id);
                    return (
                      <li key={e.id} className="group flex items-center gap-3 px-3 py-2.5">
                        {e.source === 'auto' ? (
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-soft-fg" aria-hidden><Repeat size={15} /></span>
                        ) : m ? <Avatar user={m} size="sm" /> : <span className="size-8" />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-fg">{e.note || (e.amount > 0 ? 'Deposit' : 'Withdrawal')}</div>
                          <div className="text-xs text-muted">
                            {e.source === 'auto' ? 'Automatic' : m ? firstName(m.name) : 'Someone'} · {fmtRelative(e.created_at)}{e.source === 'allowance' ? ' · allowance' : ''}
                          </div>
                        </div>
                        <span className={cn('text-sm font-semibold tabular', e.amount > 0 ? 'text-success-soft-fg' : 'text-fg')}>
                          {e.amount > 0 ? '+' : '−'}{fmt(Math.abs(e.amount))}
                        </span>
                        {editable && (
                          <IconButton icon={Trash2} size="sm" variant="ghost" label="Remove entry" onClick={() => removeEntry(e.id)} className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100" />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>
      <ContributeDialog goal={contrib ? g ?? null : null} mode={contrib ?? 'add'} onClose={() => setContrib(null)} />
      <GoalForm open={editing} onClose={() => setEditing(false)} editing={g} />
    </>
  );
}

function AllowanceForm({ member, current, goals, onClose }: { member: Member | null; current?: Allowance; goals: Goal[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { currency } = useMoney();
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('weekly');
  const [goalId, setGoalId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!member) return;
    setAmount(current ? amountToInput(current.amount) : '');
    setFrequency(current?.frequency ?? 'weekly');
    setGoalId(current?.goal_id ? String(current.goal_id) : '');
    setError('');
  }, [member, current]);
  if (!member) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    if (!n) return setError('Enter an amount greater than zero');
    setBusy(true);
    try {
      await api.put(`/budget/allowances/${member.id}`, { amount: n, frequency, goal_id: goalId ? Number(goalId) : null });
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success(`${firstName(member.name)}'s allowance saved`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    try {
      await api.del(`/budget/allowances/${member.id}`);
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success('Allowance stopped');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const theirGoals = goals.filter((g) => !g.completed_at && (g.owner_id === member.id || g.owner_id === null));
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`${firstName(member.name)}'s allowance`}
      icon={<Avatar user={member} size="md" />}
      footer={
        <>
          {current && <Button variant="ghost" className="text-danger" onClick={stop}>Stop</Button>}
          <Button type="submit" form="budget-allowance-form" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="budget-allowance-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Amount" error={error}>
          <MoneyInput size="md" value={amount} onChange={setAmount} currency={currency} autoFocus invalid={!!error} />
        </Field>
        <SegmentedControl block aria-label="How often" value={frequency} onChange={setFrequency} options={[{ value: 'weekly', label: 'Every week' }, { value: 'monthly', label: 'Every month' }]} />
        <Field label="Deposit into goal" hint="When you pay the allowance it's added to this goal">
          <Select value={goalId} onChange={(e) => setGoalId(e.target.value)} options={[{ value: '', label: 'No goal (pocket money)' }, ...theirGoals.map((g) => ({ value: String(g.id), label: `${g.emoji ?? ''} ${g.name}`.trim() }))]} />
        </Field>
      </form>
    </Modal>
  );
}

function Allowances({ goals }: { goals: Goal[] }) {
  const { members } = useAuth();
  const { fmt } = useMoney();
  const qc = useQueryClient();
  const canManage = useCanManage();
  const { data: allowances = [], isLoading } = useAllowances();
  const [editing, setEditing] = useState<Member | null>(null);
  const [paying, setPaying] = useState<number | null>(null);
  const kids = members.filter((m) => m.role === 'child');
  if (!kids.length) return null;

  const pay = async (m: Member, a: Allowance) => {
    setPaying(m.id);
    try {
      await api.post(`/budget/allowances/${m.id}/pay`, localDay());
      qc.invalidateQueries({ queryKey: keys.all });
      const goal = goals.find((g) => g.id === a.goal_id);
      toast.success(`Paid ${firstName(m.name)} ${fmt(a.amount)}`, { description: goal ? `Added to ${goal.name}` : 'Recorded under Kids' });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPaying(null);
    }
  };

  return (
    <section aria-labelledby="allowance-h">
      <div className="mb-3 flex items-center gap-2 px-1">
        <HandCoins size={18} className="text-muted" aria-hidden />
        <h2 id="allowance-h" className="text-[15px] font-semibold text-fg">Allowances</h2>
      </div>
      <div className="grid [&>*]:min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {isLoading
          ? kids.map((k) => <SkeletonCard key={k.id} />)
          : kids.map((m) => {
              const a = allowances.find((x) => x.member_id === m.id);
              const goal = goals.find((g) => g.id === a?.goal_id);
              return (
                <Card key={m.id} padding="sm" className="flex items-center gap-3 sm:p-4">
                  <Avatar user={m} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-fg">{firstName(m.name)}</div>
                    {a ? (
                      <div className="text-[13px] text-muted">
                        <span className="font-semibold text-fg tabular">{fmt(a.amount)}</span> / {a.frequency === 'weekly' ? 'week' : 'month'}
                        {goal && <span> → {goal.emoji} {goal.name}</span>}
                        <div className="text-xs text-subtle">{a.last_paid_at ? `Last paid ${fmtRelative(a.last_paid_at)}` : 'Not paid yet'}</div>
                      </div>
                    ) : (
                      <div className="text-[13px] text-muted">No allowance set</div>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      {a && <Button size="sm" icon={Banknote} loading={paying === m.id} onClick={() => pay(m, a)}>Pay</Button>}
                      <IconButton icon={a ? Settings2 : Plus} label={a ? `Allowance settings for ${firstName(m.name)}` : `Set up allowance for ${firstName(m.name)}`} variant={a ? 'ghost' : 'soft'} size="sm" onClick={() => setEditing(m)} />
                    </div>
                  )}
                </Card>
              );
            })}
      </div>
      <AllowanceForm member={editing} current={allowances.find((x) => x.member_id === editing?.id)} goals={goals} onClose={() => setEditing(null)} />
    </section>
  );
}

export default function Goals() {
  const { data: goals, isLoading, isError, refetch } = useGoals();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const { fmt } = useMoney();
  const openId = Number(params.get('goal')) || null;
  const setOpen = (id: number | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id) n.set('goal', String(id));
      else n.delete('goal');
      return n;
    });

  const active = (goals ?? []).filter((g) => !g.completed_at);
  const reached = (goals ?? []).filter((g) => g.completed_at);
  const totalSaved = active.reduce((s, g) => s + g.saved, 0);
  const totalTarget = active.reduce((s, g) => s + g.target, 0);

  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="goals-h">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-1">
          <div>
            <h2 id="goals-h" className="text-[15px] font-semibold text-fg">Savings goals</h2>
            {active.length > 0 && <p className="text-[13px] text-muted tabular">{fmt(totalSaved)} saved toward {fmt(totalTarget)} · {plural(active.length, 'goal')}</p>}
          </div>
          <Button size="sm" variant="soft" icon={Plus} onClick={() => setCreating(true)}>New goal</Button>
        </div>
        {isLoading ? (
          <div className="grid [&>*]:min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <SkeletonCard key={i} />)}</div>
        ) : isError ? (
          <Card><EmptyState compact icon={PiggyBank} accent={mod.accent} title="Couldn't load goals" action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} /></Card>
        ) : !goals?.length ? (
          <Card>
            <EmptyState icon={PiggyBank} accent={mod.accent} title="Save up for something great" description="Create a goal for a family trip, a new bike or a rainy-day fund, and watch it fill up together." action={<Button icon={Plus} onClick={() => setCreating(true)}>Create a goal</Button>} />
          </Card>
        ) : (
          <>
            {active.length > 0 && totalTarget > 0 && <Progress value={totalSaved} max={totalTarget} color={mod.accent} className="mb-4" label="All goals" warnAt={2} />}
            <div className="grid [&>*]:min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {active.map((g) => <GoalCard key={g.id} g={g} onOpen={(x) => setOpen(x.id)} />)}
            </div>
            {reached.length > 0 && (
              <>
                <h3 className="mb-2 mt-6 px-1 text-[13px] font-semibold uppercase tracking-wide text-subtle">Reached 🎉</h3>
                <div className="grid [&>*]:min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {reached.map((g) => <GoalCard key={g.id} g={g} onOpen={(x) => setOpen(x.id)} compact />)}
                </div>
              </>
            )}
          </>
        )}
      </section>
      <Allowances goals={goals ?? []} />
      <GoalForm open={creating} onClose={() => setCreating(false)} />
      <Fab label="New goal" accent={mod.accent} onClick={() => setCreating(true)} />
      <GoalDetail id={openId} onClose={() => setOpen(null)} />
    </div>
  );
}
