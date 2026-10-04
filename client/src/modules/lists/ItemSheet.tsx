import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BellRing, CalendarDays, CheckCircle2, Hash, Info, ListChecks, Tag, Trash2, User as UserIcon } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtRelative } from '../../lib/format';
import { Avatar, Button, Checkbox, Field, Input, Modal, Select, Textarea, toast } from '../../ui';
import { DueChip, duePresets } from './bits';
import { CATEGORIES, categoryEmoji } from './categories';
import { useListActions, useLists } from './data';
import { PeoplePicker } from './PeoplePicker';
import type { ItemInput, ListDetail, ListItem } from './types';

export interface ItemSheetProps {
  list: ListDetail;
  item: ListItem | null;
  onClose: () => void;
}

/** One read-only fact row (used when the viewer can't edit that field). */
function Fact({ icon: Icon, label, children }: { icon: typeof Info; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Icon size={16} className="shrink-0 text-subtle" aria-hidden />
      <span className="w-24 shrink-0 text-[13px] text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-sm font-medium text-fg">{children}</span>
    </div>
  );
}

export function ItemSheet({ list, item, onClose }: ItemSheetProps) {
  const { user, members, role } = useAuth();
  const { updateItem, deleteItem, remind } = useListActions();
  const lists = useLists().data ?? [];
  const [text, setText] = useState('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState('');
  const [assignee, setAssignee] = useState<number | null>(null);
  const [due, setDue] = useState('');
  const [moveTo, setMoveTo] = useState<number>(list.id);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nudging, setNudging] = useState(false);

  useEffect(() => {
    if (!item) return;
    setText(item.text);
    setQuantity(item.quantity ?? '');
    setNotes(item.can_edit ? item.notes ?? '' : '');
    setCategory(item.category ?? '');
    setAssignee(item.assignee_id);
    setDue(item.due_date ?? '');
    setMoveTo(list.id);
    setError(null);
    setSaving(false);
    // Only when a different item opens (not on every live refresh of the same one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const open = !!item;
  const full = item?.can_edit ?? false;
  const notesOnly = !full && (item?.can_edit_notes ?? false);
  const canSave = full || notesOnly;
  const isShopping = list.type === 'shopping';
  const byId = (id: number | null) => members.find((m) => m.id === id) ?? null;
  const creator = byId(item?.created_by ?? null);
  const doneBy = byId(item?.done_by ?? null);
  const assigneeMember = byId(item?.assignee_id ?? null);
  const categories = [...CATEGORIES, ...(category && !CATEGORIES.includes(category) ? [category] : [])];
  // Children may only assign to themselves (the server enforces this too).
  const pickerFilter = role === 'child' ? (m: { id: number }) => m.id === user?.id || m.id === item?.assignee_id : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!item) return;
    const patch: ItemInput = {};
    if (notesOnly && notes.trim()) patch.add_note = notes.trim();
    if (full && (notes.trim() || null) !== item.notes) patch.notes = notes.trim() || null;
    if (full) {
      if (!text.trim()) {
        setError('Item can’t be empty');
        return;
      }
      if (text.trim() !== item.text) patch.text = text.trim();
      if ((quantity.trim() || null) !== item.quantity) patch.quantity = quantity.trim() || null;
      if (isShopping && (category || null) !== item.category) patch.category = category || null;
      if (assignee !== item.assignee_id) patch.assignee_id = assignee;
      if ((due || null) !== item.due_date) patch.due_date = due || null;
      if (moveTo !== list.id) patch.list_id = moveTo;
    }
    if (!Object.keys(patch).length) return onClose();
    setSaving(true);
    try {
      await updateItem(list.id, item.id, patch, user?.id);
      if (patch.list_id) {
        const target = lists.find((l) => l.id === patch.list_id);
        toast.success(`Moved to ${target ? `${target.icon} ${target.name}` : 'another list'}`);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const nudge = async () => {
    if (!item) return;
    setNudging(true);
    try {
      await remind(list.id, item.id);
      toast.success(`Reminder sent to ${firstName(assigneeMember?.name)}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setNudging(false);
    }
  };

  const canNudge = item && !item.done && item.assignee_id && item.assignee_id !== user?.id && item.id > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={isShopping ? 'Item details' : 'Task details'}
      footer={
        <>
          {item?.can_delete && (
            <Button
              variant="ghost"
              icon={Trash2}
              className="text-danger sm:mr-auto"
              onClick={() => {
                if (!item) return;
                onClose();
                void deleteItem(list.id, item);
              }}
            >
              Delete
            </Button>
          )}
          {canSave ? (
            <Button type="submit" form="item-form" loading={saving}>Save</Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>Close</Button>
          )}
        </>
      }
    >
      {item && (
        <form id="item-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div
            className={cn(
              'flex items-center gap-3 rounded-2xl border px-3.5 py-3',
              item.done ? 'border-success/30 bg-success-soft' : 'border-border bg-surface-2/60',
            )}
          >
            <Checkbox
              shape="circle"
              size="lg"
              color={list.color}
              checked={item.done}
              aria-label={item.done ? `Mark “${item.text}” as not done` : `Mark “${item.text}” as done`}
              onChange={(v) => void updateItem(list.id, item.id, { done: v }, user?.id).catch(() => {})}
            />
            <div className="min-w-0 flex-1 text-[13px]">
              {item.done ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-success-soft-fg">
                  <CheckCircle2 size={14} aria-hidden /> Done{doneBy ? ` by ${firstName(doneBy.name)}` : ''} · {fmtRelative(item.done_at)}
                </span>
              ) : (
                <span className="text-muted">Not done yet</span>
              )}
              <div className="mt-0.5 flex items-center gap-1.5 text-subtle">
                {creator && <Avatar user={creator} size="xs" />}
                Added by {creator ? firstName(creator.name) : 'someone'} · {fmtRelative(item.created_at)}
              </div>
            </div>
          </div>

          {!full && (
            <p className="flex items-start gap-2 rounded-xl bg-info-soft px-3 py-2 text-[13px] text-info-soft-fg">
              <Info size={15} className="mt-px shrink-0" aria-hidden />
              {notesOnly
                ? 'You can tick this off and add notes. Ask a grown-up if the task or date needs changing.'
                : 'You can tick this off. Only grown-ups or whoever added it can change it.'}
            </p>
          )}

          {full ? (
            <>
              <div className={cn('grid gap-3', list.type !== 'todo' && 'grid-cols-[1fr_7.5rem]')}>
                <Field label={isShopping ? 'Item' : 'Task'} error={error ?? undefined} required>
                  <Input name="text" value={text} maxLength={200} onChange={(e) => { setText(e.target.value); setError(null); }} />
                </Field>
                {list.type !== 'todo' && (
                  <Field label="Quantity">
                    <Input name="quantity" value={quantity} maxLength={40} placeholder="e.g. 2 lb" onChange={(e) => setQuantity(e.target.value)} />
                  </Field>
                )}
              </div>

              {isShopping && (
                <Field label="Aisle">
                  <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {categories.map((c) => (
                      <option key={c} value={c}>{categoryEmoji(c)}  {c}</option>
                    ))}
                  </Select>
                </Field>
              )}

              <div>
                <p className="mb-2 text-sm font-medium text-fg">{isShopping ? 'Who’s getting it?' : 'Assigned to'}</p>
                <PeoplePicker value={assignee} onChange={setAssignee} filter={pickerFilter} aria-label="Assignee" />
              </div>

              {!isShopping && (
                <div>
                  <label htmlFor="item-due" className="mb-2 block text-sm font-medium text-fg">Due date</label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input id="item-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-auto" size="sm" />
                    {duePresets().slice(0, 3).map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setDue(p.value)}
                        aria-pressed={due === p.value}
                        className={cn(
                          'rounded-full border px-3 py-1.5 text-[13px] font-medium transition active:scale-95',
                          due === p.value ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-border text-muted hover:text-fg',
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                    {due && (
                      <button type="button" onClick={() => setDue('')} className="px-2 py-1.5 text-[13px] font-medium text-muted hover:text-fg">
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="divide-y divide-border rounded-2xl border border-border px-3.5">
              <Fact icon={ListChecks} label={isShopping ? 'Item' : 'Task'}>{item.text}</Fact>
              {item.quantity && <Fact icon={Hash} label="Quantity">{item.quantity}</Fact>}
              {isShopping && item.category && <Fact icon={Tag} label="Aisle">{categoryEmoji(item.category)} {item.category}</Fact>}
              <Fact icon={UserIcon} label={isShopping ? 'Getting it' : 'Assigned to'}>
                {assigneeMember ? (
                  <span className="inline-flex items-center gap-2"><Avatar user={assigneeMember} size="xs" /> {assigneeMember.name}</span>
                ) : (
                  <span className="text-muted">Nobody yet</span>
                )}
              </Fact>
              {!isShopping && (
                <Fact icon={CalendarDays} label="Due">
                  {item.due_date ? <DueChip due={item.due_date} done={item.done} /> : <span className="text-muted">No due date</span>}
                </Fact>
              )}
              {item.notes && (
                <Fact icon={Info} label="Notes">
                  <span className="whitespace-pre-line font-normal">{item.notes}</span>
                </Fact>
              )}
            </div>
          )}

          {canSave && (
            <Field
              label={notesOnly ? 'Add a note' : 'Notes'}
              hint={notesOnly ? 'Your note is added below with your name — it won’t replace anything.' : undefined}
              error={!full ? error ?? undefined : undefined}
            >
              <Textarea
                name="notes"
                value={notes}
                autoGrow
                rows={2}
                maxLength={notesOnly ? 500 : 4000}
                placeholder={notesOnly ? 'e.g. Done except the closet!' : isShopping ? 'Brand, size, details…' : list.type === 'todo' ? 'Steps, where things are, tips…' : 'Details…'}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          )}

          {full && lists.length > 1 && (
            <Field label="List">
              <Select value={String(moveTo)} onChange={(e) => setMoveTo(Number(e.target.value))}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>{l.icon}  {l.name}</option>
                ))}
              </Select>
            </Field>
          )}

          {canNudge && (
            <div className="flex items-center gap-3 rounded-2xl border border-border p-3">
              <Avatar user={assigneeMember} size="sm" />
              <p className="min-w-0 flex-1 text-[13px] text-muted">Need a hand? Send {firstName(assigneeMember?.name)} a reminder.</p>
              <Button size="sm" variant="soft" icon={BellRing} loading={nudging} onClick={nudge}>Nudge</Button>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
