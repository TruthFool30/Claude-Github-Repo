import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, KeyRound, Lock, LockOpen, Pencil, Plus, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useMember } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtRelative } from '../../lib/format';
import {
  Avatar, Button, Card, EmptyState, Fab, Field, IconButton, Input, Menu, Modal, Skeleton, Spinner, Textarea, toast, useConfirm,
} from '../../ui';
import { keys, useNotes, type NoteField, type NoteKind, type VaultNote, type Visibility } from './api';
import { ACCENT, NOTE_KINDS, NOTE_KIND_ORDER, Tile, copyText } from './meta';
import { Chip, SearchField, VisibilityBadge, VisibilityPicker } from './parts';
import { useAuth } from '../../lib/auth';

const REVEAL_MS = 30_000;
const MASK = '••••••••';

export default function NotesSection() {
  const highlightId = Number(useParams()['*']) || null;
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useNotes();
  const [revealed, setRevealed] = useState<Record<number, { note: VaultNote; until: number }>>({});
  const [editing, setEditing] = useState<VaultNote | { kind: NoteKind } | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<NoteKind | 'all'>('all');
  const notes = data ?? [];

  // Drop revealed secrets when they time out or the card changed/vanished.
  useEffect(() => {
    const ids = Object.keys(revealed);
    if (!ids.length) return;
    const next = Math.min(...Object.values(revealed).map((r) => r.until)) - Date.now();
    const t = setTimeout(() => {
      setRevealed((cur) => Object.fromEntries(Object.entries(cur).filter(([, r]) => r.until > Date.now())));
    }, Math.max(0, next));
    return () => clearTimeout(t);
  }, [revealed]);
  useEffect(() => {
    if (!data) return;
    setRevealed((cur) => {
      const keep = Object.entries(cur).filter(([id, r]) => data.some((n) => n.id === Number(id) && n.updated_at === r.note.updated_at));
      return keep.length === Object.keys(cur).length ? cur : Object.fromEntries(keep);
    });
  }, [data]);
  // Hide everything when the tab is hidden (screen shared, phone put down…).
  useEffect(() => {
    const onVis = () => document.visibilityState === 'hidden' && setRevealed({});
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!highlightId || !data) return;
    const el = document.getElementById(`vault-note-${highlightId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  }, [highlightId, data]);

  const reveal = async (n: VaultNote) => {
    try {
      const full = await api.get<VaultNote>(`/vault/notes/${n.id}/reveal`);
      setRevealed((cur) => ({ ...cur, [n.id]: { note: full, until: Date.now() + REVEAL_MS } }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const hide = (id: number) => setRevealed((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => Number(k) !== id)));

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading info cards">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}
      </div>
    );
  }
  if (isError) {
    return <Card><EmptyState icon={KeyRound} accent={ACCENT} title="Couldn't load info cards" action={<Button onClick={() => refetch()}>Try again</Button>} /></Card>;
  }

  const q = query.trim().toLowerCase();
  const shown = notes.filter((n) => (kind === 'all' || n.kind === kind) && (!q || [n.title, n.body, ...n.fields.map((f) => `${f.label} ${f.value ?? ''}`)].join(' ').toLowerCase().includes(q)));
  const kindsPresent = NOTE_KIND_ORDER.filter((k) => notes.some((n) => n.kind === k));

  return (
    <div>
      {notes.length === 0 ? (
        <Card>
          <EmptyState
            icon={ShieldCheck}
            accent={ACCENT}
            title="Keep important info handy"
            description="Wi-Fi passwords, insurance numbers, alarm codes — secret values stay hidden until someone taps to reveal them."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {(['wifi', 'insurance', 'code'] as NoteKind[]).map((k) => {
                  const K = NOTE_KINDS[k];
                  return <Button key={k} variant="secondary" icon={K.icon} onClick={() => setEditing({ kind: k })}>{K.label}</Button>;
                })}
                <Button icon={Plus} onClick={() => setEditing({ kind: 'other' })}>New card</Button>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchField value={query} onChange={setQuery} placeholder="Search info cards" label="Search info cards" className="min-w-0 flex-1" />
            <Button icon={Plus} onClick={() => setEditing({ kind: 'other' })} className="max-sm:hidden!">New info card</Button>
          </div>
          {kindsPresent.length > 1 && (
            <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-0.5 scrollbar-none sm:mx-0 sm:px-0" role="group" aria-label="Filter by type">
              <Chip active={kind === 'all'} onClick={() => setKind('all')} count={notes.length}>All</Chip>
              {kindsPresent.map((k) => (
                <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? 'all' : k)} icon={NOTE_KINDS[k].icon} color={NOTE_KINDS[k].color}>{NOTE_KINDS[k].label}</Chip>
              ))}
            </div>
          )}
          {shown.length ? (
            <ul className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((n) => (
                <NoteCard
                  key={n.id}
                  note={n}
                  revealed={revealed[n.id]}
                  highlighted={n.id === highlightId}
                  onReveal={() => reveal(n)}
                  onHide={() => hide(n.id)}
                  onEdit={() => setEditing(n)}
                  onDeleted={() => highlightId === n.id && navigate('/vault/notes', { replace: true })}
                />
              ))}
            </ul>
          ) : (
            <Card><EmptyState compact icon={KeyRound} accent={ACCENT} title="No matching cards" description="Secret values aren't searchable — try the card's title." /></Card>
          )}
          <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-subtle">
            <Lock size={12} aria-hidden /> Secret values are only sent to your device when you tap to reveal, and hide again after 30 seconds.
          </p>
        </>
      )}
      <Fab label="New info card" accent={ACCENT} onClick={() => setEditing({ kind: 'other' })} />
      <NoteFormModal
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={(n) => { hide(n.id); }}
      />
    </div>
  );
}

function NoteCard({ note, revealed, highlighted, onReveal, onHide, onEdit, onDeleted }: {
  note: VaultNote; revealed?: { note: VaultNote; until: number }; highlighted: boolean; onReveal: () => Promise<void>; onHide: () => void; onEdit: () => void; onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const owner = useMember(note.owner_id);
  const K = NOTE_KINDS[note.kind];
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const fields: NoteField[] = revealed ? revealed.note.fields : note.fields;
  const isOpen = !!revealed;

  const doReveal = async () => {
    setRevealing(true);
    await onReveal();
    setRevealing(false);
  };
  const copy = async (value: string, i: number) => {
    if (await copyText(value)) {
      setCopied(i);
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
      toast.success('Copied');
    } else toast.error('Could not copy');
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete “${note.title}”?`, message: note.visibility !== 'family' ? 'This card will be permanently deleted.' : 'It will be removed for everyone in the family.', confirmLabel: 'Delete', danger: true }))) return;
    const prev = qc.getQueryData<VaultNote[]>(keys.notes);
    qc.setQueryData<VaultNote[]>(keys.notes, (old) => old?.filter((n) => n.id !== note.id));
    try {
      await api.del(`/vault/notes/${note.id}`);
      toast.success('Card deleted');
      qc.invalidateQueries({ queryKey: keys.all });
      onDeleted();
    } catch (e) {
      qc.setQueryData(keys.notes, prev);
      toast.error(errorMessage(e));
    }
  };

  return (
    <li
      id={`vault-note-${note.id}`}
      tabIndex={-1}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-2xl border bg-surface shadow-card outline-none transition-shadow duration-300',
        highlighted ? 'border-transparent ring-4 ring-ring' : 'border-border',
      )}
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: K.color }} aria-hidden />
      <div className="flex items-start gap-3 p-4 pb-3">
        <Tile color={K.color} icon={K.icon} size={40} rounded="rounded-xl" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-fg">{note.title}</h3>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="truncate">{K.label}</span>
          </div>
        </div>
        {note.can_edit && (
          <Menu label={`Actions for ${note.title}`} items={[
            { label: 'Edit card', icon: Pencil, onSelect: onEdit },
            { label: 'Delete card', icon: Trash2, danger: true, onSelect: remove },
          ]} />
        )}
      </div>

      {note.unreadable && <p role="status" className="mx-4 flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[13px] font-medium text-warning-soft-fg"><TriangleAlert size={15} aria-hidden /> Contents can't be decrypted</p>}
      {fields.length > 0 && (
        <dl className="mx-4 divide-y divide-border rounded-xl border border-border bg-surface-2/50">
          {fields.map((f, i) => {
            const hidden = f.secret && f.value === null;
            return (
              <div key={i} className="flex min-h-12 items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <dt className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                    {f.secret && (isOpen ? <LockOpen size={10} aria-hidden /> : <Lock size={10} aria-hidden />)}
                    {f.label}
                  </dt>
                  <dd className={cn('break-words text-[15px] text-fg', f.secret && 'font-mono tracking-wide')}>
                    {hidden ? (
                      <button
                        type="button"
                        onClick={doReveal}
                        className="rounded-md text-left font-mono tracking-[0.2em] text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
                        aria-label={`Reveal ${f.label}`}
                      >
                        {MASK}
                      </button>
                    ) : (
                      <span className={cn(f.secret && 'animate-fade-in')}>{f.value}</span>
                    )}
                  </dd>
                </div>
                {!hidden && f.value && (
                  <IconButton size="sm" icon={copied === i ? Check : Copy} label={`Copy ${f.label}`} onClick={() => copy(f.value!, i)} />
                )}
              </div>
            );
          })}
        </dl>
      )}
      {note.body && <p className="mx-4 mt-3 whitespace-pre-line text-[13px] leading-relaxed text-muted">{note.body}</p>}

      {note.visibility !== 'family' && <div className="mx-4 mt-3"><VisibilityBadge value={note.visibility} /></div>}
      <div className="mt-auto flex items-center gap-2 px-4 pb-4 pt-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-subtle">
          {owner && <Avatar user={owner} size="xs" />}
          <span className="truncate">{owner ? firstName(owner.name) : 'Former member'} · {fmtRelative(note.updated_at)}</span>
        </span>
        {note.secret_count > 0 && (
          isOpen ? (
            <Button size="sm" variant="soft" icon={EyeOff} onClick={onHide} className="relative overflow-hidden">
              Hide
              <RevealTimer until={revealed!.until} />
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={revealing ? <Spinner size={14} /> : Eye} onClick={doReveal} disabled={revealing}>
              Tap to reveal
            </Button>
          )
        )}
      </div>
    </li>
  );
}

/** Shrinking bar that shows how long secrets stay visible. */
function RevealTimer({ until }: { until: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const remaining = Math.max(0, until - Date.now());
    el.animate([{ transform: `scaleX(${remaining / REVEAL_MS})` }, { transform: 'scaleX(0)' }], { duration: remaining, fill: 'forwards', easing: 'linear' });
  }, [until]);
  return <span ref={ref} aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary-soft-fg/60" />;
}

// ---------------------------------------------------------------------------------------------

interface FieldDraft { label: string; value: string; secret: boolean; show: boolean }

function NoteFormModal({ target, onClose, onSaved }: { target: VaultNote | { kind: NoteKind } | null; onClose: () => void; onSaved: (n: VaultNote) => void }) {
  const qc = useQueryClient();
  const existing = target && 'id' in target ? target : null;
  const locked = !!existing?.unreadable; // contents can't be decrypted: only title/type/visibility are editable
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<NoteKind>('other');
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>([]);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('family');
  const { role } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);

  const applyTemplate = (k: NoteKind, keepTitle = false) => {
    setKind(k);
    if (!keepTitle && !titleTouched) setTitle(k === 'other' ? '' : NOTE_KINDS[k].label === 'Wi-Fi' ? 'Home Wi-Fi' : NOTE_KINDS[k].label);
    setFields((cur) => {
      const filled = cur.filter((f) => f.value.trim());
      if (filled.length) return cur;
      return NOTE_KINDS[k].template.map((t) => ({ label: t.label, value: '', secret: t.secret, show: false }));
    });
  };

  useEffect(() => {
    if (!target) return;
    setError('');
    setSaving(false);
    setTitleTouched(false);
    if (existing) {
      setKind(existing.kind);
      setTitle(existing.title);
      setBody(existing.body ?? '');
      setVisibility(existing.visibility);
      const load = (n: VaultNote) => setFields(n.fields.map((f) => ({ label: f.label, value: f.value ?? '', secret: f.secret, show: false })));
      if (existing.secret_count) {
        setLoading(true);
        api.get<VaultNote>(`/vault/notes/${existing.id}/reveal`).then(load, (e) => setError(errorMessage(e))).finally(() => setLoading(false));
      } else load(existing);
    } else {
      setBody('');
      setVisibility('family');
      setFields([]);
      setTitle('');
      const k = (target as { kind: NoteKind }).kind;
      setKind(k);
      setFields(NOTE_KINDS[k].template.map((t) => ({ label: t.label, value: '', secret: t.secret, show: false })));
      setTitle(k === 'other' ? '' : k === 'wifi' ? 'Home Wi-Fi' : NOTE_KINDS[k].label);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const setField = (i: number, patch: Partial<FieldDraft>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = fields.filter((f) => f.label.trim() || f.value.trim());
    if (!title.trim()) return setError('Give the card a title');
    const bad = clean.find((f) => !f.label.trim() || !f.value.trim());
    if (bad) return setError(bad.label.trim() ? `“${bad.label}” needs a value` : 'Every field needs a label');
    if (!locked && !clean.length && !body.trim()) return setError('Add at least one field or some text');
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = locked ? { title, kind } : { title, kind, body, fields: clean.map(({ label, value, secret }) => ({ label, value, secret })) };
      if (!existing || existing.is_owner) payload.visibility = visibility;
      const saved = existing ? await api.patch<VaultNote>(`/vault/notes/${existing.id}`, payload) : await api.post<VaultNote>('/vault/notes', payload);
      qc.setQueryData<VaultNote[]>(keys.notes, (old) => (old ? (existing ? old.map((n) => (n.id === saved.id ? saved : n)) : [saved, ...old]) : old));
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success(existing ? 'Card updated' : 'Card saved');
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const K = NOTE_KINDS[kind];
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      title={existing ? 'Edit info card' : 'New info card'}
      description="Mark sensitive values as secret — they stay hidden until tapped."
      icon={<Tile color={K.color} icon={K.icon} size={40} rounded="rounded-xl" />}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="vault-note-form" loading={saving} disabled={loading}>{existing ? 'Save changes' : 'Save card'}</Button></>}
    >
      {loading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <form id="vault-note-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-fg">{error}</p>}
          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold text-fg">Type</legend>
            <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0" role="radiogroup" aria-label="Card type">
              {NOTE_KIND_ORDER.map((k) => {
                const T = NOTE_KINDS[k];
                const on = k === kind;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => (existing ? setKind(k) : applyTemplate(k))}
                    className={cn('inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring', on ? 'border-transparent text-fg' : 'border-border text-muted hover:text-fg')}
                    style={on ? { backgroundColor: `color-mix(in oklab, ${T.color} 16%, transparent)`, boxShadow: `inset 0 0 0 1.5px ${T.color}` } : undefined}
                  >
                    <T.icon size={15} style={{ color: T.color }} aria-hidden /> {T.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Field label="Title" required>
            <Input value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} maxLength={80} placeholder="e.g. Home Wi-Fi" />
          </Field>
          {locked ? (
            <p role="status" className="flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm font-medium text-warning-soft-fg">
              <TriangleAlert size={16} aria-hidden /> This card's fields and notes can't be decrypted. Restore the encryption key to edit them.
            </p>
          ) : (<>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-[13px] font-semibold text-fg">Fields</legend>
            {fields.map((f, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-border p-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:border-0 sm:p-0">
                <Input aria-label={`Field ${i + 1} label`} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder="Label" maxLength={60} size="md" className="col-span-2 sm:col-span-1" />
                <Input
                  aria-label={`Field ${i + 1} value`}
                  value={f.value}
                  type={f.secret && !f.show ? 'password' : 'text'}
                  autoComplete="off"
                  onChange={(e) => setField(i, { value: e.target.value })}
                  placeholder={f.secret ? 'Secret value' : 'Value'}
                  maxLength={500}
                  trailing={f.secret ? <IconButton size="sm" icon={f.show ? EyeOff : Eye} label={f.show ? 'Hide value' : 'Show value'} onClick={() => setField(i, { show: !f.show })} /> : undefined}
                />
                <div className="flex items-center gap-1">
                  <IconButton
                    icon={f.secret ? Lock : LockOpen}
                    label={f.secret ? `Make ${f.label || 'field'} visible` : `Make ${f.label || 'field'} secret`}
                    aria-pressed={f.secret}
                    variant={f.secret ? 'soft' : 'ghost'}
                    onClick={() => setField(i, { secret: !f.secret })}
                  />
                  <IconButton icon={X} label={`Remove field ${i + 1}`} onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} />
                </div>
              </div>
            ))}
            {fields.length < 12 && (
              <Button type="button" variant="ghost" size="sm" icon={Plus} className="self-start" onClick={() => setFields((fs) => [...fs, { label: '', value: '', secret: false, show: false }])}>Add field</Button>
            )}
            <p className="flex items-center gap-1.5 text-xs text-subtle"><Lock size={12} aria-hidden /> Locked fields are masked everywhere until someone taps “reveal”.</p>
          </fieldset>
          <Field label="Notes" hint="Always visible on the card — don't put passwords here.">
            <Textarea rows={2} autoGrow value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
          </Field>
          </>)}
          {(!existing || existing.is_owner) && (
            <div className="rounded-2xl border border-border p-3">
              <VisibilityPicker value={visibility} onChange={setVisibility} allowAdults={role === 'admin' || role === 'member'} what="this card" />
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
