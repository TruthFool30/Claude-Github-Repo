// Recurring monthly bills: status per month, mark paid / skip / undo, create + edit templates.
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft, ArrowUpRight, CalendarClock, Check, CircleAlert, Pencil, Plus, Repeat, SkipForward, Trash2, Undo2,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useMember } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDate, plural } from '../../lib/format';
import {
  Avatar, Badge, Button, Card, EmptyState, Field, Input, Menu, MemberPicker, Modal, SegmentedControl, Select, SkeletonList, Switch,
  Textarea, toast, useConfirm,
} from '../../ui';
import {
  amountToInput, currentMonth, keys, localDay, monthLabel, parseAmount, useBills, useCanManage, useCategories, useMoney, useMonthParam, type Bill, type Kind,
} from './api';
import { CategoryIcon, MoneyInput, Progress } from './shared';
import mod from './index';

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/** Marks bills that record themselves (autopay). */
export function AutoBadge() {
  return (
    <span
      title="Recorded automatically on the due date"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border px-1 text-[10px] font-semibold uppercase leading-4 tracking-wide text-muted"
    >
      <Repeat size={10} aria-hidden />
      Auto
    </span>
  );
}

const STATUS: Record<Bill['status'], { label: string; tone: 'success' | 'neutral' | 'danger' | 'warning' | 'info' }> = {
  paid: { label: 'Paid', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  overdue: { label: 'Overdue', tone: 'danger' },
  due_today: { label: 'Due today', tone: 'warning' },
  upcoming: { label: 'Upcoming', tone: 'info' },
};

/** Optimistic "mark paid" / "skip" / "undo" for a bill in a given month. */
export function useBillActions(month: string) {
  const qc = useQueryClient();
  const optimistic = (id: number, patch: Partial<Bill>) => {
    const key = keys.bills(month);
    const prev = qc.getQueryData<Bill[]>(key);
    qc.setQueryData<Bill[]>(key, (old) => old?.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    return () => qc.setQueryData(key, prev);
  };
  const run = async (fn: () => Promise<unknown>, rollback: () => void, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      rollback();
      toast.error(errorMessage(e));
    } finally {
      qc.invalidateQueries({ queryKey: keys.all });
    }
  };
  return {
    pay: (b: Bill, amount?: number) =>
      run(() => api.post(`/budget/recurring/${b.id}/pay`, { month, amount, ...localDay() }), optimistic(b.id, { status: 'paid', paid_amount: amount ?? b.amount }), `${b.description} marked ${b.kind === 'income' ? 'received' : 'paid'}`),
    skip: (b: Bill) => run(() => api.post(`/budget/recurring/${b.id}/skip`, { month, ...localDay() }), optimistic(b.id, { status: 'skipped' }), `${b.description} skipped for ${monthLabel(month)}`),
    undo: (b: Bill) => run(() => api.del(`/budget/recurring/${b.id}/runs/${month}`), () => {}, 'Undone'),
  };
}

export function BillRow({ b, month, compact }: { b: Bill; month: string; compact?: boolean }) {
  const { fmt } = useMoney();
  const canManage = useCanManage();
  const payer = useMember(b.paid_by);
  const actions = useBillActions(month);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const st = STATUS[b.status];
  const done = b.status === 'paid' || b.status === 'skipped';

  const remove = async () => {
    if (!(await confirm({ title: `Delete ${b.description}?`, message: 'Future months stop being tracked. Past payments stay in your transactions.', confirmLabel: 'Delete bill', danger: true }))) return;
    try {
      await api.del(`/budget/recurring/${b.id}`);
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success('Bill deleted');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <li className={cn('flex items-center gap-3 py-3', compact ? 'px-1' : 'px-2')}>
      <div className="relative">
        <CategoryIcon category={b.category} />
        {b.status === 'paid' && (
          <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-success text-white ring-2 ring-surface animate-check" aria-hidden>
            <Check size={10} strokeWidth={3.5} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-[15px] font-semibold', done ? 'text-muted' : 'text-fg')}>{b.description}</span>
          {b.auto_create && <AutoBadge />}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
          <Badge tone={st.tone} size="sm">{b.status === 'overdue' && <CircleAlert size={11} />}{st.label}</Badge>
          <span className="truncate">
            {b.status === 'paid' && b.paid_date ? fmtDate(b.paid_date, 'MMM d') : `Due ${fmtDate(b.due_date, 'MMM d')}`}
          </span>
          {!compact && payer && <Avatar user={payer} size="xs" title={`Usually paid by ${payer.name}`} />}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={cn('text-[15px] font-semibold tabular', b.kind === 'income' ? 'text-success-soft-fg' : done ? 'text-muted' : 'text-fg', b.status === 'skipped' && 'line-through')}>
          {b.kind === 'income' ? '+' : ''}{fmt(b.status === 'paid' && b.paid_amount != null ? b.paid_amount : b.amount)}
        </span>
        {canManage && !done && (
          <Button size="sm" variant="soft" icon={Check} onClick={() => actions.pay(b)} aria-label={`Mark ${b.description} ${b.kind === 'income' ? 'received' : 'paid'}`} className={compact ? 'px-2' : 'max-sm:px-2'}>
            <span className={compact ? 'sr-only' : 'max-sm:sr-only'}>{b.kind === 'income' ? 'Mark received' : 'Mark paid'}</span>
          </Button>
        )}
        {canManage && (
          <Menu
            label={`Actions for ${b.description}`}
            items={[
              !done && { label: 'Paid a different amount…', icon: Check, onSelect: () => setPaying(true) },
              !done && { label: `Skip ${monthLabel(month, 'short')}`, icon: SkipForward, onSelect: () => actions.skip(b) },
              done && { label: b.status === 'paid' ? 'Undo payment' : 'Undo skip', icon: Undo2, onSelect: () => actions.undo(b) },
              'divider',
              { label: 'Edit bill', icon: Pencil, onSelect: () => setEditing(true) },
              { label: 'Delete bill', icon: Trash2, danger: true, onSelect: remove },
            ]}
          />
        )}
      </div>
      <BillForm open={editing} onClose={() => setEditing(false)} editing={b} />
      <PayDialog open={paying} onClose={() => setPaying(false)} bill={b} onPay={(n) => actions.pay(b, n)} />
    </li>
  );
}

function PayDialog({ open, onClose, bill, onPay }: { open: boolean; onClose: () => void; bill: Bill; onPay: (n: number) => Promise<void> }) {
  const { currency } = useMoney();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setValue(amountToInput(bill.amount));
      setError('');
    }
  }, [open, bill.amount]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(value);
    if (!n) return setError('Enter an amount greater than zero');
    setBusy(true);
    await onPay(n);
    setBusy(false);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={`Pay ${bill.description}`}
      description={`Record this month's ${bill.kind === 'income' ? 'income' : 'payment'} with the actual amount.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="budget-pay-form" loading={busy}>Mark paid</Button></>}
    >
      <form id="budget-pay-form" onSubmit={submit}>
        <Field label="Amount" error={error}>
          <MoneyInput value={value} onChange={setValue} currency={currency} autoFocus invalid={!!error} ariaLabel="Amount paid" />
        </Field>
      </form>
    </Modal>
  );
}

export function BillForm({ open, onClose, editing }: { open: boolean; onClose: () => void; editing?: Bill | null }) {
  const qc = useQueryClient();
  const { currency } = useMoney();
  const { data: categories = [] } = useCategories();
  const [kind, setKind] = useState<Kind>('expense');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [day, setDay] = useState('1');
  const [paidBy, setPaidBy] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);
  const [startMonth, setStartMonth] = useState(currentMonth());
  const [endMonth, setEndMonth] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(editing?.kind ?? 'expense');
    setDescription(editing?.description ?? '');
    setAmount(editing ? amountToInput(editing.amount) : '');
    setCategoryId(editing?.category_id ? String(editing.category_id) : '');
    setDay(String(editing?.day_of_month ?? new Date().getDate()));
    setPaidBy(editing?.paid_by ?? null);
    setAuto(editing?.auto_create ?? false);
    setStartMonth(editing?.start_month ?? currentMonth());
    setEndMonth(editing?.end_month ?? '');
    setNotes(editing?.notes ?? '');
    setErrors({});
  }, [open, editing]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    const errs: Record<string, string> = {};
    if (!description.trim()) errs.description = 'Give the bill a name';
    if (!n) errs.amount = 'Enter an amount greater than zero';
    if (endMonth && endMonth < startMonth) errs.endMonth = 'Must be after the start month';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const body = {
        kind, description: description.trim(), amount: n, category_id: categoryId ? Number(categoryId) : null, day_of_month: Number(day),
        paid_by: paidBy, auto_create: auto, start_month: startMonth, end_month: endMonth || null, notes: notes.trim() || null,
      };
      if (editing) await api.patch(`/budget/recurring/${editing.id}`, { ...body, ...localDay() });
      else await api.post('/budget/recurring', { ...body, ...localDay() });
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success(editing ? 'Bill updated' : 'Monthly bill added');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={editing ? 'Edit monthly bill' : 'New monthly bill'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="budget-bill-form" loading={saving}>{editing ? 'Save' : 'Add bill'}</Button></>}
    >
      <form id="budget-bill-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <SegmentedControl
          block
          aria-label="Type"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setCategoryId('');
          }}
          options={[{ value: 'expense', label: 'Bill', icon: ArrowUpRight }, { value: 'income', label: 'Income', icon: ArrowDownLeft }]}
        />
        <Field label="Name" error={errors.description} required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} placeholder={kind === 'income' ? 'e.g. Salary' : 'e.g. Electric bill, Netflix'} autoFocus={!editing} />
        </Field>
        <div className="grid [&>*]:min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Amount" error={errors.amount} required>
            <MoneyInput size="md" value={amount} onChange={setAmount} currency={currency} invalid={!!errors.amount} />
          </Field>
          <Field label="Due every month on the">
            <Select value={day} onChange={(e) => setDay(e.target.value)} options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `${ordinal(i + 1)}${i >= 28 ? ' (or last day)' : ''}` }))} />
          </Field>
        </div>
        <Field label="Category">
          <Select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            options={[{ value: '', label: 'Uncategorized' }, ...categories.filter((c) => c.kind === kind).map((c) => ({ value: String(c.id), label: c.name }))]}
          />
        </Field>
        <Field label={kind === 'income' ? 'Received by' : 'Usually paid by'}>
          <MemberPicker value={paidBy} onChange={setPaidBy} />
        </Field>
        <div className="rounded-2xl border border-border p-3.5">
          <Switch
            checked={auto}
            onChange={setAuto}
            label="Record automatically"
            description="For autopay: Hearth adds the transaction on the due date. Otherwise you'll get a reminder and mark it paid yourself."
          />
        </div>
        <div className="grid [&>*]:min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Starts">
            <Input type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value || currentMonth())} />
          </Field>
          <Field label="Ends" hint={errors.endMonth ? undefined : 'Leave empty to keep going'} error={errors.endMonth}>
            <Input type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} placeholder="Account number, how to pay…" />
        </Field>
      </form>
    </Modal>
  );
}

export default function Bills() {
  const [month] = useMonthParam();
  const { fmt } = useMoney();
  const canManage = useCanManage();
  const { data, isLoading, isError, refetch } = useBills(month);
  const [adding, setAdding] = useState(false);
  const bills = data ?? [];
  const expense = bills.filter((b) => b.kind === 'expense');
  const income = bills.filter((b) => b.kind === 'income');
  const attention = expense.filter((b) => b.status === 'overdue' || b.status === 'due_today');
  const open = expense.filter((b) => b.status === 'upcoming');
  const settled = expense.filter((b) => b.status === 'paid' || b.status === 'skipped');
  const total = expense.reduce((s, b) => s + (b.status === 'paid' && b.paid_amount != null ? b.paid_amount : b.status === 'skipped' ? 0 : b.amount), 0);
  const paidTotal = expense.filter((b) => b.status === 'paid').reduce((s, b) => s + (b.paid_amount ?? b.amount), 0);

  if (isLoading) return <Card><SkeletonList rows={6} /></Card>;
  if (isError) {
    return <Card><EmptyState compact icon={Repeat} accent={mod.accent} title="Couldn't load bills" action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} /></Card>;
  }
  if (!bills.length) {
    return (
      <Card>
        <EmptyState
          icon={CalendarClock}
          accent={mod.accent}
          title="No monthly bills yet"
          description="Add rent, subscriptions and other bills once — Hearth tracks them every month and reminds you when they're due."
          action={canManage ? <Button icon={Plus} onClick={() => setAdding(true)}>Add a bill</Button> : undefined}
        />
        <BillForm open={adding} onClose={() => setAdding(false)} />
      </Card>
    );
  }

  const section = (title: string, list: Bill[], hint?: string) =>
    list.length > 0 && (
      <Card padding="sm" className="sm:p-4">
        <div className="flex items-baseline justify-between px-2 pb-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-subtle">{title}</h3>
          {hint && <span className="text-xs text-muted">{hint}</span>}
        </div>
        <ul className="divide-y divide-border">{list.map((b) => <BillRow key={b.id} b={b} month={month} />)}</ul>
      </Card>
    );

  return (
    <div className="grid [&>*]:min-w-0 grid-cols-1 gap-5 lg:grid-cols-[1fr_320px] lg:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        {section('Needs attention', attention, attention.length ? plural(attention.length, 'bill') : undefined)}
        {section('Coming up', open)}
        {section('Paid & skipped', settled)}
        {section('Recurring income', income)}
      </div>
      <Card className="order-first lg:order-none lg:sticky lg:top-24">
        <div className="text-[13px] font-medium text-muted">Bills in {monthLabel(month)}</div>
        <div className="mt-1 text-2xl font-bold tracking-tight text-fg tabular">
          {fmt(paidTotal)} <span className="text-base font-medium text-muted">of {fmt(total)}</span>
        </div>
        <Progress value={paidTotal} max={total || 1} color={mod.accent} className="mt-3" label="Bills paid" warnAt={2} />
        <div className="mt-2 text-[13px] text-muted">
          {settled.length} of {expense.length} settled{attention.length ? ` · ${attention.length} need attention` : ''}
        </div>
        {canManage && <Button block variant="soft" icon={Plus} className="mt-4" onClick={() => setAdding(true)}>Add monthly bill</Button>}
        <p className="mt-3 flex items-start gap-1.5 text-xs text-subtle"><AutoBadge /> bills are recorded automatically on their due date.</p>
      </Card>
      <BillForm open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
