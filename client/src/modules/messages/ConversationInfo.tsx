import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Crown, Images, LogOut, Pencil, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDate } from '../../lib/format';
import { Avatar, Badge, Button, ColorPicker, Field, IconButton, Input, Lightbox, MemberPicker, Switch, toast, useConfirm } from '../../ui';
import { flatten, keys, useHistory } from './data';
import { ConversationAvatar, GROUP_EMOJIS, conversationSubtitle, shortName } from './parts';
import type { Conversation } from './types';

export function ConversationInfo({ conv, onClose, className }: { conv: Conversation; onClose?: () => void; className?: string }) {
  const { user, role, members } = useAuth();
  const meId = user!.id;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(conv.name ?? '');
  const [emoji, setEmoji] = useState(conv.emoji ?? '💬');
  const [color, setColor] = useState(conv.color ?? '#8E4EC6');
  const [toAdd, setToAdd] = useState<number[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const hist = useHistory(conv.id);

  const isGroup = conv.kind === 'group';
  const canManage = isGroup && (role === 'admin' || conv.created_by === meId);
  const photos = useMemo(
    () => flatten(hist.data).filter((m) => !m.deleted && m.id > 0).flatMap((m) => m.attachments.map((a) => ({ ...a, message: m }))).reverse(),
    [hist.data],
  );
  const candidates = members.filter((m) => !m.managed && !conv.participants.some((p) => p.id === m.id));

  const refresh = (c?: Conversation) => {
    if (c) qc.setQueryData(keys.conversation(conv.id), c);
    void qc.invalidateQueries({ queryKey: keys.conversations });
    void qc.invalidateQueries({ queryKey: keys.unread });
  };

  const toggleMute = async (muted: boolean) => {
    qc.setQueryData<Conversation>(keys.conversation(conv.id), (c) => (c ? { ...c, muted } : c));
    try {
      refresh(await api.put<Conversation>(`/messages/conversations/${conv.id}/mute`, { muted }));
      toast.success(muted ? 'Conversation muted' : 'Notifications back on');
    } catch (e) {
      qc.setQueryData<Conversation>(keys.conversation(conv.id), (c) => (c ? { ...c, muted: !muted } : c));
      toast.error(errorMessage(e));
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast.error('Give the group a name');
    setBusy('save');
    try {
      refresh(await api.patch<Conversation>(`/messages/conversations/${conv.id}`, { name: name.trim(), emoji, color }));
      setEditing(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!toAdd.length) return;
    setBusy('add');
    try {
      refresh(await api.post<Conversation>(`/messages/conversations/${conv.id}/members`, { user_ids: toAdd }));
      setToAdd([]);
      setAdding(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (userId: number, label: string) => {
    const ok = await confirm({ title: `Remove ${label}?`, message: `${label} will no longer see new messages in “${conv.title}”.`, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      await api.del(`/messages/conversations/${conv.id}/members/${userId}`);
      refresh();
      void qc.invalidateQueries({ queryKey: keys.conversation(conv.id) });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const leave = async () => {
    const ok = await confirm({ title: `Leave “${conv.title}”?`, message: "You won't get new messages from this group unless someone adds you back.", confirmLabel: 'Leave group', danger: true });
    if (!ok) return;
    try {
      await api.del(`/messages/conversations/${conv.id}/members/${meId}`);
      qc.setQueryData<Conversation[]>(keys.conversations, (l) => l?.filter((c) => c.id !== conv.id));
      refresh();
      toast.success(`You left “${conv.title}”`);
      navigate('/messages');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const destroy = async () => {
    const ok = await confirm({ title: `Delete “${conv.title}”?`, message: 'All messages and photos in this group will be deleted for everyone. This cannot be undone.', confirmLabel: 'Delete group', danger: true });
    if (!ok) return;
    try {
      await api.del(`/messages/conversations/${conv.id}`);
      qc.setQueryData<Conversation[]>(keys.conversations, (l) => l?.filter((c) => c.id !== conv.id));
      refresh();
      toast.success('Group deleted');
      navigate('/messages');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className={cn('flex flex-col', className)}>
      {onClose && (
        <div className="flex items-center justify-between px-4 pt-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-subtle">Details</h2>
          <IconButton icon={X} label="Close details" size="sm" onClick={onClose} />
        </div>
      )}
      <div className="flex flex-col items-center px-5 pb-5 pt-4 text-center">
        <ConversationAvatar conv={conv} meId={meId} size={76} className="shadow-lift" />
        <h3 className="mt-3 text-xl font-bold tracking-tight text-fg">{conv.title}</h3>
        <p className="mt-0.5 text-sm text-muted">{conversationSubtitle(conv, meId)}</p>
        {isGroup && !editing && (
          <Button size="sm" variant="secondary" icon={Pencil} className="mt-3" onClick={() => setEditing(true)}>
            Edit group
          </Button>
        )}
      </div>

      {editing && (
        <form onSubmit={save} className="mx-4 mb-4 space-y-3 rounded-2xl border border-border bg-surface-2/60 p-4 animate-fade-in">
          <Field label="Group name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
          </Field>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Group icon">
            {GROUP_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={emoji === e}
                aria-label={e}
                onClick={() => setEmoji(e)}
                className={cn('flex size-9 items-center justify-center rounded-lg text-lg', emoji === e ? 'bg-primary-soft ring-2 ring-primary' : 'bg-surface hover:bg-surface-3')}
              >
                {e}
              </button>
            ))}
          </div>
          <ColorPicker value={color} onChange={setColor} size="sm" aria-label="Group color" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" type="submit" loading={busy === 'save'}>Save</Button>
          </div>
        </form>
      )}

      <div className="mx-4 mb-4 rounded-2xl border border-border p-1">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <Bell size={18} className="shrink-0 text-muted" aria-hidden />
          <Switch
            checked={conv.muted}
            onChange={toggleMute}
            label="Mute conversation"
            description="Left out of the unread badge. You’ll still be notified when someone @mentions you or writes @everyone."
            className="flex-1"
          />
        </div>
      </div>

      <section className="mx-4 mb-4" aria-labelledby={`members-${conv.id}`}>
        <div className="mb-2 flex items-center justify-between">
          <h4 id={`members-${conv.id}`} className="text-[13px] font-bold uppercase tracking-wide text-subtle">
            {conv.participants.length} {conv.participants.length === 1 ? 'person' : 'people'}
          </h4>
          {isGroup && candidates.length > 0 && !adding && (
            <Button size="sm" variant="ghost" icon={UserPlus} onClick={() => setAdding(true)}>Add</Button>
          )}
        </div>
        {adding && (
          <div className="mb-3 space-y-3 rounded-2xl border border-border bg-surface-2/60 p-3 animate-fade-in">
            <MemberPicker multiple value={toAdd} onChange={setToAdd} members={candidates} aria-label="People to add" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setToAdd([]); }}>Cancel</Button>
              <Button size="sm" onClick={add} disabled={!toAdd.length} loading={busy === 'add'}>Add {toAdd.length || ''}</Button>
            </div>
          </div>
        )}
        <ul className="space-y-0.5">
          {conv.participants.map((p) => (
            <li key={p.id} className="flex items-center gap-3 rounded-xl px-1.5 py-1.5">
              <Avatar user={p} size="md" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold text-fg">
                  {p.nickname || p.name} {p.id === meId && <span className="font-normal text-subtle">(you)</span>}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  {p.role === 'admin' && <Crown size={11} aria-hidden />}
                  {p.role === 'admin' ? 'Admin' : p.role === 'child' ? 'Child' : 'Member'}
                  {isGroup && conv.created_by === p.id && <Badge tone="primary" size="sm">Created group</Badge>}
                </div>
              </div>
              {canManage && p.id !== meId && (
                <IconButton icon={UserMinus} label={`Remove ${shortName(p)}`} size="sm" variant="danger" onClick={() => remove(p.id, shortName(p))} />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-4 mb-4" aria-label="Shared photos">
        <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-wide text-subtle">
          <Images size={14} aria-hidden /> Photos
        </h4>
        {photos.length ? (
          <div className="grid grid-cols-3 gap-1.5">
            {photos.slice(0, 9).map((a, i) => (
              <button key={`${a.message.id}-${a.id}`} type="button" onClick={() => setPhotoIndex(i)} className="aspect-square overflow-hidden rounded-xl bg-surface-3 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring" aria-label={`Open photo from ${fmtDate(a.message.created_at)}`}>
                <img src={a.url} alt="" loading="lazy" className="size-full object-cover transition hover:scale-105" />
              </button>
            ))}
          </div>
        ) : (
          <p className="rounded-2xl bg-surface-2 px-3 py-3 text-[13px] text-muted">Photos shared here will show up in this spot.</p>
        )}
      </section>

      {isGroup && (
        <div className="mx-4 mb-5 mt-auto space-y-2 pt-2">
          <p className="pb-1 text-center text-xs text-subtle">New people can read earlier messages. If someone leaves and is added back, they won’t see what was said while they were away.</p>
          <Button variant="outline" block icon={LogOut} onClick={leave}>Leave group</Button>
          {canManage && (
            <Button variant="danger" block icon={Trash2} onClick={destroy}>Delete group</Button>
          )}
        </div>
      )}
      {conv.kind === 'family' && (
        <p className="mx-4 mb-5 mt-auto text-center text-xs text-subtle">Everyone in the family is part of this chat, including new members. Type @everyone to notify the whole family.</p>
      )}

      <Lightbox
        images={photos.slice(0, 9).map((a) => ({ src: a.url, caption: `${a.message.user_id === meId ? 'You' : shortName(conv.participants.find((p) => p.id === a.message.user_id) ?? members.find((p) => p.id === a.message.user_id))} · ${fmtDate(a.message.created_at)}` }))}
        index={photoIndex}
        onClose={() => setPhotoIndex(null)}
        onIndexChange={setPhotoIndex}
      />
    </div>
  );
}
