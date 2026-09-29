import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  Cake, Copy, Crown, Link2, LogOut, Pencil, RefreshCw, Shield, Smile, Trash2, UserPlus, Users, Baby,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { age, fmtDate, plural } from '../lib/format';
import type { Family as FamilyT, Member, Role } from '../lib/types';
import {
  Avatar, Badge, Button, Card, CardHeader, ColorPicker, Field, IconButton, ImageUploader, Input, Menu, Modal, PageHeader,
  SegmentedControl, Select, Switch, fileForm, toast, useConfirm, PALETTE,
} from '../ui';
import { FamilyAvatar } from '../layout/FamilyAvatar';
import { PasswordInput } from './PasswordInput';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'INR', 'SGD', 'ZAR', 'MYR'];
const roleMeta: Record<Role, { label: string; tone: 'primary' | 'neutral' | 'warning'; icon: typeof Crown }> = {
  admin: { label: 'Admin', tone: 'primary', icon: Crown },
  member: { label: 'Member', tone: 'neutral', icon: Shield },
  child: { label: 'Child', tone: 'warning', icon: Smile },
};

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('Could not copy — select and copy it manually');
  }
}

export default function FamilyPage() {
  const { family, user, isAdmin, refresh, forgetFamily } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  if (!family || !user) return null;

  const inviteLink = family.invite_code ? `${window.location.origin}/join/${family.invite_code}` : '';
  const loginMembers = family.members.filter((m) => !m.managed && m.id !== user.id);
  const soleAdmin = isAdmin && family.members.filter((m) => m.role === 'admin').length === 1 && loginMembers.length > 0;

  const rotate = async () => {
    const ok = await confirm({
      title: 'Create a new invite code?',
      message: 'The current code and invite link will stop working. People already in the family are not affected.',
      confirmLabel: 'New code',
    });
    if (!ok) return;
    setRotating(true);
    try {
      await api.post('/family/invite-code/rotate');
      await refresh();
      toast.success('New invite code created');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRotating(false);
    }
  };

  const changeRole = async (m: Member, role: Role) => {
    try {
      await api.patch(`/family/members/${m.id}`, { role });
      await refresh();
      toast.success(`${m.name} is now ${roleMeta[role].label.toLowerCase() === 'admin' ? 'an admin' : `a ${roleMeta[role].label.toLowerCase()}`}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (m: Member) => {
    const ok = await confirm({
      title: `Remove ${m.name}?`,
      message: m.managed ? 'Their profile will be deleted.' : 'They will lose access to this family. They can rejoin with an invite code.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/family/members/${m.id}`);
      await refresh();
      toast.success(`${m.name} was removed`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const leave = async () => {
    if (soleAdmin) {
      toast.warning('Make someone else an admin first', { description: 'A family needs at least one admin.' });
      return;
    }
    const last = loginMembers.length === 0;
    const ok = await confirm({
      title: `Leave ${family.name}?`,
      message: last
        ? "You're the last person who can sign in, so the family and everything in it will be deleted."
        : "You'll lose access to everything shared in this family until someone invites you back.",
      confirmLabel: last ? 'Leave and delete' : 'Leave family',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/family/members/${user.id}`);
      await forgetFamily(family.id);
      toast.success(last ? `${family.name} was deleted` : `You left ${family.name}`);
      navigate('/home');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader title="Family" subtitle="Members, invitations and family settings" icon={Users} accent="#F76B15" />

      <Card padding="none" className="mb-6 overflow-hidden">
        <div className="relative h-36 sm:h-48" style={{ background: 'linear-gradient(135deg, #F7A84A 0%, #E5484D 50%, #8E4EC6 100%)' }}>
          {family.cover_url && <img src={family.cover_url} alt="" className="absolute inset-0 size-full object-cover" />}
          <div className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
          {isAdmin && (
            <div className="absolute right-3 top-3">
              <Button size="sm" variant="secondary" icon={Pencil} className="bg-surface/90 backdrop-blur" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-4 px-5 pb-5 sm:px-6">
          <FamilyAvatar family={{ name: family.name }} size={76} className="-mt-10 shadow-lift ring-4 ring-surface" />
          <div className="min-w-0 flex-1 pt-3">
            <h2 className="truncate text-2xl font-bold tracking-tight text-fg">{family.name}</h2>
            <p className="text-sm text-muted">
              {plural(family.members.length, 'member')} · {family.currency} · since {fmtDate(family.created_at, 'MMMM yyyy')}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader
            title="Members"
            subtitle={plural(family.members.length, 'person', 'people')}
            icon={Users}
            accent="#F76B15"
            action={isAdmin && <Button size="sm" variant="soft" icon={UserPlus} onClick={() => setAddOpen(true)}>Add member</Button>}
          />
          <ul className="-mx-2 divide-y divide-border">
            {family.members.map((m) => {
              const meta = roleMeta[m.role];
              const years = age(m.birthday);
              const isMe = m.id === user.id;
              return (
                <li key={m.id} className="flex items-center gap-3 px-2 py-3">
                  <Avatar user={m} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[15px] font-semibold text-fg">{m.name}</span>
                      {isMe && <Badge tone="info">You</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                      <Badge tone={meta.tone}>
                        <meta.icon size={11} /> {meta.label}
                      </Badge>
                      {m.birthday && (
                        <span className="inline-flex items-center gap-1">
                          <Cake size={13} /> {fmtDate(m.birthday, 'MMM d')}
                          {years !== null && years < 18 ? ` · ${years}y` : ''}
                        </span>
                      )}
                      {m.managed && <span className="text-subtle">No login</span>}
                    </div>
                  </div>
                  {isAdmin && !isMe && (
                    <Menu
                      label={`Actions for ${m.name}`}
                      items={[
                        m.role !== 'admin' && { label: 'Make admin', icon: Crown, onSelect: () => changeRole(m, 'admin') },
                        m.role !== 'member' && !m.managed && { label: 'Make member', icon: Shield, onSelect: () => changeRole(m, 'member') },
                        m.role !== 'child' && { label: 'Mark as child', icon: Baby, onSelect: () => changeRole(m, 'child') },
                        'divider',
                        { label: 'Remove from family', icon: Trash2, danger: true, onSelect: () => remove(m) },
                      ]}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="flex flex-col gap-6">
          {isAdmin && family.invite_code ? (
          <Card>
            <CardHeader title="Invite family" subtitle="Share the code or link" icon={Link2} accent="#5B5BD6" />
            <div className="flex items-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-2/60 p-2 pl-4">
              <span className="flex-1 select-all font-mono text-[22px] font-bold tracking-[0.18em] text-fg" data-testid="invite-code">
                {family.invite_code}
              </span>
              <IconButton icon={Copy} label="Copy invite code" variant="secondary" onClick={() => copy(family.invite_code!, 'Invite code')} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={Link2} onClick={() => copy(inviteLink, 'Invite link')} className="flex-1">
                Copy invite link
              </Button>
              <Button size="sm" variant="ghost" icon={RefreshCw} loading={rotating} onClick={rotate}>
                New code
              </Button>
            </div>
          </Card>
          ) : (
            <Card>
              <CardHeader title="Invite family" subtitle="Want to add someone?" icon={Link2} accent="#5B5BD6" />
              <p className="text-sm text-muted">Ask a family admin for the invite link — only admins can share it.</p>
            </Card>
          )}

          <Card>
            <CardHeader title="Leave family" subtitle={soleAdmin ? 'Make someone else an admin first' : 'Remove yourself from this family'} icon={LogOut} accent="#E5484D" />
            <Button variant="secondary" block icon={LogOut} className="text-danger" onClick={leave}>
              Leave {family.name}
            </Button>
            {isAdmin && (
              <Button variant="ghost" block icon={Trash2} className="mt-2 text-danger" onClick={() => setDeleteOpen(true)}>
                Delete family
              </Button>
            )}
          </Card>
        </div>
      </div>

      {isAdmin && (
        <DeleteFamilyModal
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          family={family}
          onDeleted={() => {
            navigate('/home');
          }}
        />
      )}
      {isAdmin && <EditFamilyModal open={editOpen} onClose={() => setEditOpen(false)} family={family} />}
      {isAdmin && <AddMemberModal open={addOpen} onClose={() => setAddOpen(false)} usedColors={family.members.map((m) => m.color)} />}
    </div>
  );
}

function EditFamilyModal({ open, onClose, family }: { open: boolean; onClose: () => void; family: FamilyT }) {
  const { refresh } = useAuth();
  const [name, setName] = useState(family.name);
  const [currency, setCurrency] = useState(family.currency);
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch('/family', { name, currency });
      await refresh();
      toast.success('Family updated');
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
      title="Edit family"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="edit-family" loading={saving} disabled={!name.trim()}>Save changes</Button>
        </>
      }
    >
      <form id="edit-family" onSubmit={save} className="flex flex-col gap-5">
        <ImageUploader
          label="Cover photo"
          value={family.cover_url}
          aspect="3 / 1"
          onSelect={async (file) => {
            await api.upload('/family/cover', fileForm(file));
            await refresh();
            toast.success('Cover photo updated');
          }}
          onRemove={async () => {
            await api.patch('/family', { cover_url: null });
            await refresh();
          }}
        />
        <Field label="Family name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Currency" hint="Used by the budget and meal planner.">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
        </Field>
      </form>
    </Modal>
  );
}

function AddMemberModal({ open, onClose, usedColors }: { open: boolean; onClose: () => void; usedColors: string[] }) {
  const { refresh } = useAuth();
  const freeColor = PALETTE.find((c) => !usedColors.includes(c)) ?? PALETTE[0];
  const blank = { name: '', role: 'child' as 'child' | 'member', birthday: '', color: freeColor, canLogin: false, email: '', password: '' };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    onClose();
    setTimeout(() => {
      setForm({ ...blank });
      setError(null);
    }, 250);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post('/family/members', {
        name: form.name,
        role: form.role,
        birthday: form.birthday || undefined,
        color: form.color,
        email: form.canLogin ? form.email : undefined,
        password: form.canLogin ? form.password : undefined,
      });
      await refresh();
      toast.success(`${form.name} was added to the family`);
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a family member"
      description="Great for kids or anyone who doesn't need their own account yet."
      footer={
        <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" form="add-member" loading={saving} disabled={!form.name.trim()} icon={UserPlus}>Add member</Button>
        </>
      }
    >
      <form id="add-member" onSubmit={save} className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Avatar user={{ name: form.name || '?', color: form.color }} size="xl" />
          <Field label="Name" className="flex-1">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Leo" maxLength={80} />
          </Field>
        </div>
        <Field label="Role">
          <SegmentedControl
            block
            value={form.role}
            onChange={(role) => setForm({ ...form, role })}
            options={[
              { value: 'child', label: 'Child', icon: Smile },
              { value: 'member', label: 'Adult member', icon: Shield },
            ]}
          />
        </Field>
        <Field label="Birthday" hint="Optional — shows up on the family calendar.">
          <Input type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
        </Field>
        <Field label="Color">
          <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} size="sm" />
        </Field>
        <div className="rounded-2xl border border-border p-4">
          <Switch
            checked={form.canLogin}
            onChange={(canLogin) => setForm({ ...form, canLogin })}
            label="Can sign in"
            description="Give them their own email and password."
          />
          {form.canLogin && (
            <div className="mt-4 flex flex-col gap-4 animate-fade-in">
              <Field label="Email">
                <Input type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="leo@example.com" />
              </Field>
              <Field label="Password" hint="At least 6 characters. They can change it later.">
                <PasswordInput autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
            </div>
          )}
        </div>
        {error && <p className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger-soft-fg" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function DeleteFamilyModal({
  open, onClose, family, onDeleted,
}: { open: boolean; onClose: () => void; family: FamilyT; onDeleted: () => void }) {
  const { forgetFamily } = useAuth();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === family.name.trim().toLowerCase();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    try {
      await api.del('/family', { confirm_name: typed });
      await forgetFamily(family.id);
      toast.success(`${family.name} was deleted`);
      onClose();
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setTyped('');
      }}
      title="Delete this family?"
      description="This permanently deletes the calendar, lists, messages, photos, budget and everything else for every member. This cannot be undone."
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="delete-family" variant="danger" icon={Trash2} loading={busy} disabled={!matches}>Delete forever</Button>
        </>
      }
    >
      <form id="delete-family" onSubmit={submit}>
        <Field label={<>Type <span className="font-bold">{family.name}</span> to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder={family.name} />
        </Field>
      </form>
    </Modal>
  );
}
