// Categories & monthly limits manager.
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button, ColorPicker, Field, Input, Modal, SegmentedControl, SkeletonList, toast, useConfirm } from '../../ui';
import { amountToInput, keys, parseAmount, useCanManage, useCategories, useMoney, type Category, type Kind } from './api';
import { CategoryIcon, ICONS, ICON_KEYS, MoneyInput } from './shared';

function CategoryEditor({ open, onClose, editing, kind }: { open: boolean; onClose: () => void; editing: Category | null; kind: Kind }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { currency } = useMoney();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('circle-dashed');
  const [color, setColor] = useState('#12A594');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<{ name?: string; limit?: string }>({});
  const [busy, setBusy] = useState(false);
  const k = editing?.kind ?? kind;

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setIcon(editing?.icon ?? 'sparkles');
    setColor(editing?.color ?? '#12A594');
    setLimit(editing?.monthly_limit ? amountToInput(editing.monthly_limit) : '');
    setError({});
  }, [open, editing]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof error = {};
    if (!name.trim()) errs.name = 'Give it a name';
    const lim = limit.trim() ? parseAmount(limit) : null;
    if (limit.trim() && lim === null) errs.limit = 'Enter a valid amount';
    setError(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), icon, color, ...(k === 'expense' ? { monthly_limit: lim } : {}) };
      if (editing) await api.patch(`/budget/categories/${editing.id}`, body);
      else await api.post('/budget/categories', { ...body, kind: k });
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success(editing ? 'Category saved' : 'Category added');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    const ok = await confirm({
      title: `Delete ${editing.name}?`,
      message: 'Its transactions and bills stay, but become uncategorized.',
      confirmLabel: 'Delete category',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/budget/categories/${editing.id}`);
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success('Category deleted');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={editing ? 'Edit category' : k === 'income' ? 'New income category' : 'New expense category'}
      footer={
        <>
          {editing && <Button variant="ghost" icon={Trash2} className="text-danger hover:bg-danger-soft hover:text-danger" onClick={remove}>Delete</Button>}
          <Button type="submit" form="budget-cat-form" loading={busy}>{editing ? 'Save' : 'Add'}</Button>
        </>
      }
    >
      <form id="budget-cat-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex items-end gap-3">
          <CategoryIcon category={{ icon, color }} size="lg" />
          <Field label="Name" error={error.name} className="flex-1" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Pets" autoFocus={!editing} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold text-fg">Icon</legend>
          <div className="grid [&>*]:min-w-0 grid-cols-6 gap-1.5 sm:grid-cols-10" role="radiogroup" aria-label="Icon">
            {ICON_KEYS.map((key) => {
              const I = ICONS[key];
              const on = key === icon;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={key.replace(/-/g, ' ')}
                  onClick={() => setIcon(key)}
                  className={cn('flex aspect-square items-center justify-center rounded-xl border transition active:scale-90', on ? 'border-transparent' : 'border-transparent text-muted hover:bg-surface-2 hover:text-fg')}
                  style={on ? { backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`, color, borderColor: color } : undefined}
                >
                  <I size={18} />
                </button>
              );
            })}
          </div>
        </fieldset>
        <Field label="Color">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        {k === 'expense' && (
          <Field label="Monthly limit" hint="Leave empty for no limit" error={error.limit}>
            <MoneyInput size="md" value={limit} onChange={setLimit} currency={currency} placeholder="No limit" invalid={!!error.limit} name="limit" />
          </Field>
        )}
      </form>
    </Modal>
  );
}

export function CategoryManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: categories, isLoading } = useCategories();
  const { fmt } = useMoney();
  const canManage = useCanManage();
  const [kind, setKind] = useState<Kind>('expense');
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const list = (categories ?? []).filter((c) => c.kind === kind);
  const totalLimit = list.reduce((s, c) => s + (c.monthly_limit ?? 0), 0);
  const child = editing !== null || creating;

  return (
    <>
      <Modal
        open={open && !child}
        onClose={onClose}
        title="Categories & limits"
        description="Set a monthly limit to see progress bars on the overview."
        footer={canManage ? <Button icon={Plus} onClick={() => setCreating(true)}>New category</Button> : undefined}
      >
        <SegmentedControl block aria-label="Category type" value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Expenses' }, { value: 'income', label: 'Income' }]} className="mb-4" />
        {isLoading ? (
          <SkeletonList rows={6} />
        ) : (
          <ul className="-mx-2 flex flex-col">
            {list.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={!canManage}
                  onClick={() => setEditing(c)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <CategoryIcon category={c} />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{c.name}</span>
                  {kind === 'expense' && (
                    <span className={cn('text-sm tabular', c.monthly_limit ? 'font-semibold text-fg' : 'text-subtle')}>
                      {c.monthly_limit ? `${fmt(c.monthly_limit)}/mo` : 'No limit'}
                    </span>
                  )}
                  {canManage && <ChevronRight size={16} className="text-subtle" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        )}
        {kind === 'expense' && totalLimit > 0 && (
          <p className="mt-3 border-t border-border pt-3 text-sm text-muted">Total monthly budget: <span className="font-semibold text-fg tabular">{fmt(totalLimit)}</span></p>
        )}
      </Modal>
      <CategoryEditor
        open={open && child}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
        editing={editing}
        kind={kind}
      />
    </>
  );
}
