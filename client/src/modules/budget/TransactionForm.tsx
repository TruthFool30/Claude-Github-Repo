// Add / edit a transaction (bottom sheet on phones, dialog on desktop).
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Paperclip, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { toDateKey } from '../../lib/format';
import { Button, Field, ImageUploader, Input, MemberPicker, Modal, SegmentedControl, Textarea, fileForm, toast } from '../../ui';
import { amountToInput, keys, localDay, parseAmount, useCanManage, useCategories, useMoney, type Kind, type Transaction } from './api';
import { CategoryIcon, MoneyInput } from './shared';

export interface TxDraft {
  kind?: Kind;
  date?: string;
  category_id?: number | null;
}

const MAX_RECEIPT = 25 * 1024 * 1024;

export function TransactionForm({
  open, onClose, editing, draft, onSaved, onReceiptRetry,
}: {
  open: boolean; onClose: () => void; editing?: Transaction | null; draft?: TxDraft; onSaved?: (t: Transaction) => void;
  /** Called from the "Try again" action when the receipt upload failed (opens the saved row for editing). */
  onReceiptRetry?: (t: Transaction) => void;
}) {
  const { user } = useAuth();
  const canManage = useCanManage();
  const { currency } = useMoney();
  const qc = useQueryClient();
  const { data: categories = [] } = useCategories();

  const [kind, setKind] = useState<Kind>('expense');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(toDateKey());
  const [paidBy, setPaidBy] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [removeReceipt, setRemoveReceipt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ amount?: string; date?: string }>({});

  // Reset whenever the sheet opens.
  useEffect(() => {
    if (!open) return;
    setKind(editing?.kind ?? draft?.kind ?? 'expense');
    setAmount(editing ? amountToInput(editing.amount) : '');
    setDescription(editing?.description ?? '');
    setCategoryId(editing ? editing.category_id : draft?.category_id ?? null);
    setDate(editing?.date ?? draft?.date ?? toDateKey());
    setPaidBy(editing ? editing.paid_by : user?.id ?? null);
    setNotes(editing?.notes ?? '');
    setReceipt(null);
    setReceiptPreview(null);
    setRemoveReceipt(false);
    setErrors({});
  }, [open, editing, draft, user?.id]);

  useEffect(() => () => {
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
  }, [receiptPreview]);

  const visible = useMemo(() => categories.filter((c) => c.kind === kind), [categories, kind]);
  const changeKind = (k: Kind) => {
    setKind(k);
    if (categoryId && categories.find((c) => c.id === categoryId)?.kind !== k) setCategoryId(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    const errs: typeof errors = {};
    if (n === null) errs.amount = 'Enter an amount greater than zero (e.g. 12.50)';
    if (!date || date < '1970-01-01' || date > '2100-12-31') errs.date = 'Pick a date between 1970 and 2100';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    let saved: Transaction;
    try {
      const body = { kind, amount: n, description: description.trim() || null, category_id: categoryId, date, paid_by: paidBy, notes: notes.trim() || null, ...localDay() };
      saved = editing
        ? await api.patch<Transaction>(`/budget/transactions/${editing.id}`, body)
        : await api.post<Transaction>('/budget/transactions', body);
    } catch (err) {
      setSaving(false);
      toast.error(errorMessage(err));
      return;
    }
    // The transaction itself is saved at this point: never leave the sheet in "Add" mode (a retry
    // would create a duplicate). A failed receipt upload is reported but doesn't undo the save.
    let receiptFailed = '';
    try {
      if (receipt) saved = await api.upload<Transaction>(`/budget/transactions/${saved.id}/receipt`, fileForm(receipt));
      else if (removeReceipt && editing?.receipt_url) saved = await api.del<Transaction>(`/budget/transactions/${saved.id}/receipt`);
    } catch (err) {
      receiptFailed = errorMessage(err);
    }
    setSaving(false);
    void qc.invalidateQueries({ queryKey: keys.all });
    const what = editing ? 'Transaction updated' : kind === 'income' ? 'Income added' : 'Expense added';
    if (receiptFailed) {
      toast.warning(`${what}, but the receipt wasn't attached`, {
        description: receiptFailed,
        action: { label: 'Try again', onClick: () => onReceiptRetry?.(saved) },
      });
    } else toast.success(what);
    onSaved?.(saved);
    onClose();
  };

  /** Validate a picked receipt before accepting it (type + size). */
  const pickReceipt = (f: File) => {
    if (!/^image\//.test(f.type) && f.type !== 'application/pdf') {
      toast.error('Receipts must be a photo or a PDF');
      return;
    }
    if (f.size > MAX_RECEIPT) {
      toast.error('That file is too large (max 25 MB)');
      return;
    }
    setReceipt(f);
    setReceiptPreview(URL.createObjectURL(f));
    setRemoveReceipt(false);
  };

  const shownReceipt = receiptPreview ?? (removeReceipt ? null : editing?.receipt_url ?? null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={editing ? 'Edit transaction' : kind === 'income' ? 'Add income' : 'Add expense'}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="budget-tx-form" loading={saving}>{editing ? 'Save changes' : 'Add'}</Button>
        </>
      }
    >
      <form id="budget-tx-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {canManage && (
          <SegmentedControl
            block
            aria-label="Transaction type"
            value={kind}
            onChange={changeKind}
            options={[
              { value: 'expense', label: 'Expense', icon: ArrowUpRight },
              { value: 'income', label: 'Income', icon: ArrowDownLeft },
            ]}
          />
        )}
        <Field label="Amount" error={errors.amount} required>
          <MoneyInput value={amount} onChange={setAmount} currency={currency} autoFocus={!editing} invalid={!!errors.amount} ariaLabel="Amount" />
        </Field>
        <Field label="Description">
          <Input
            name="description"
            value={description}
            maxLength={140}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={kind === 'income' ? 'e.g. Paycheck, freelance job' : "e.g. Trader Joe's, pizza night"}
          />
        </Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold text-fg">Category</legend>
          <div className="grid [&>*]:min-w-0 grid-cols-3 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Category">
            {visible.map((c) => {
              const on = c.id === categoryId;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setCategoryId(on ? null : c.id)}
                  className={cn(
                    'flex min-w-0 flex-col items-center gap-1.5 rounded-2xl border px-1.5 py-2.5 text-center text-xs font-semibold transition-all active:scale-95',
                    on ? 'text-fg shadow-card' : 'border-border text-muted hover:border-border-strong hover:text-fg',
                  )}
                  style={on ? { borderColor: c.color, backgroundColor: `color-mix(in oklab, ${c.color} 10%, var(--surface))` } : undefined}
                >
                  <CategoryIcon category={c} size="sm" />
                  <span className="w-full truncate">{c.name}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
        <Field label="Date" error={errors.date} required className="sm:max-w-[50%]">
          <Input type="date" name="date" value={date} min="1970-01-01" max="2100-12-31" onChange={(e) => setDate(e.target.value)} />
        </Field>
        {canManage && (
          <Field label={kind === 'income' ? 'Received by' : 'Paid by'}>
            <MemberPicker value={paidBy} onChange={setPaidBy} aria-label={kind === 'income' ? 'Received by' : 'Paid by'} />
          </Field>
        )}
        <Field label="Notes">
          <Textarea name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} autoGrow maxLength={1000} placeholder="Anything to remember?" />
        </Field>
        <div>
          <span className="mb-2 block text-[13px] font-semibold text-fg">Receipt</span>
          {shownReceipt ? (
            <div className="flex items-center gap-3 rounded-2xl border border-border p-2.5">
              {/\.pdf$/i.test(shownReceipt) ? (
                <span className="flex size-14 items-center justify-center rounded-xl bg-surface-2 text-xs font-bold text-muted">PDF</span>
              ) : (
                <img src={shownReceipt} alt="Receipt preview" className="size-14 rounded-xl object-cover" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-muted">{receipt ? receipt.name : 'Receipt attached'}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={Trash2}
                onClick={() => {
                  setReceipt(null);
                  setReceiptPreview(null);
                  setRemoveReceipt(true);
                }}
              >
                Remove
              </Button>
            </div>
          ) : (
            <ImageUploader onSelect={pickReceipt}>
              <Button variant="secondary" size="sm" icon={Paperclip}>Attach a photo</Button>
            </ImageUploader>
          )}
        </div>
      </form>
    </Modal>
  );
}
