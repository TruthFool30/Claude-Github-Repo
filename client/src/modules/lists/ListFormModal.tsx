import { useEffect, useState, type FormEvent } from 'react';
import { CheckSquare, ShoppingCart, StickyNote } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button, ColorPicker, Field, Input, Modal, PALETTE, SegmentedControl, toast } from '../../ui';
import { ListTile } from './bits';
import { EMOJIS, TYPE_META } from './categories';
import { useListActions } from './data';
import type { ListSummary, ListType } from './types';

const TEMPLATES: Array<{ name: string; type: ListType; icon: string; color: string }> = [
  { name: 'Groceries', type: 'shopping', icon: '🛒', color: '#30A46C' },
  { name: 'Chores', type: 'todo', icon: '🧹', color: '#F76B15' },
  { name: 'Packing list', type: 'other', icon: '🧳', color: '#0090FF' },
  { name: 'Gift ideas', type: 'other', icon: '🎁', color: '#D6409F' },
  { name: 'Home projects', type: 'todo', icon: '🛠️', color: '#8E4EC6' },
];

export interface ListFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Edit this list; omit to create. */
  list?: ListSummary | null;
  /** Preselected type when creating. */
  initialType?: ListType;
  onSaved?: (list: { id: number }) => void;
}

export function ListFormModal({ open, onClose, list, initialType = 'shopping', onSaved }: ListFormModalProps) {
  const { createList, updateList } = useListActions();
  const [name, setName] = useState('');
  const [type, setType] = useState<ListType>(initialType);
  const [icon, setIcon] = useState(TYPE_META[initialType].icon);
  const [color, setColor] = useState(TYPE_META[initialType].color);
  const [touchedLook, setTouchedLook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    if (list) {
      setName(list.name);
      setType(list.type);
      setIcon(list.icon);
      setColor(list.color);
      setTouchedLook(true);
    } else {
      setName('');
      setType(initialType);
      setIcon(TYPE_META[initialType].icon);
      setColor(TYPE_META[initialType].color);
      setTouchedLook(false);
    }
  }, [open, list, initialType]);

  const pickType = (t: ListType) => {
    setType(t);
    if (!touchedLook) {
      setIcon(TYPE_META[t].icon);
      setColor(TYPE_META[t].color);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) {
      setError('Give your list a name');
      return;
    }
    setSaving(true);
    try {
      const saved = list ? await updateList(list.id, { name: clean, type, icon, color }) : await createList({ name: clean, type, icon, color });
      toast.success(list ? 'List updated' : `${icon} ${clean} created`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={list ? 'Edit list' : 'New list'}
      icon={<ListTile icon={icon} color={color} size={40} />}
      description={list ? undefined : 'Groceries, chores, packing — anything the family shares.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="list-form" loading={saving}>{list ? 'Save' : 'Create list'}</Button>
        </>
      }
    >
      <form id="list-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {!list && (
          <div>
            <p className="mb-2 text-[13px] font-medium text-muted">Start from</p>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-none">
              {TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => {
                    setName(t.name);
                    setType(t.type);
                    setIcon(t.icon);
                    setColor(t.color);
                    setTouchedLook(true);
                    setError(null);
                  }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-fg transition hover:border-border-strong hover:bg-surface-2 active:scale-95"
                >
                  <span aria-hidden>{t.icon}</span>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="Name" error={error ?? undefined} required>
          <Input
            name="name"
            value={name}
            maxLength={80}
            autoFocus={!list}
            placeholder="e.g. Groceries"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium text-fg">Type</p>
          <SegmentedControl
            block
            aria-label="List type"
            value={type}
            onChange={pickType}
            options={[
              { value: 'shopping', label: 'Shopping', icon: ShoppingCart },
              { value: 'todo', label: 'To-do', icon: CheckSquare },
              { value: 'other', label: 'Other', icon: StickyNote },
            ]}
          />
          <p className="mt-2 text-[13px] text-muted">{TYPE_META[type].hint}</p>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-fg" id="list-icon-label">Icon</p>
          <div role="radiogroup" aria-labelledby="list-icon-label" className="grid grid-cols-8 gap-1.5 sm:flex sm:flex-wrap">
            {EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                role="radio"
                aria-checked={icon === em}
                aria-label={em}
                onClick={() => {
                  setIcon(em);
                  setTouchedLook(true);
                }}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-xl text-[22px] transition active:scale-90 sm:size-10 sm:text-xl',
                  icon === em ? 'bg-surface-2 ring-2' : 'hover:bg-surface-2',
                )}
                style={icon === em ? ({ '--tw-ring-color': color } as React.CSSProperties) : undefined}
              >
                {em}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-fg">Color</p>
          <ColorPicker
            value={color}
            colors={PALETTE}
            onChange={(c) => {
              setColor(c);
              setTouchedLook(true);
            }}
          />
        </div>
      </form>
    </Modal>
  );
}
