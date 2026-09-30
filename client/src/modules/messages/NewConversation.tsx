import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, MessageCircle, Users } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { Avatar, Badge, Button, ColorPicker, Field, Input, MemberPicker, Modal, SegmentedControl, toast } from '../../ui';
import { keys } from './data';
import { ACCENT, GROUP_EMOJIS } from './parts';
import type { Conversation } from './types';

type Mode = 'direct' | 'group';

export function NewConversationModal({ open, onClose, initialMode = 'direct' }: { open: boolean; onClose: () => void; initialMode?: Mode }) {
  const { user, members } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('💬');
  const [color, setColor] = useState('#8E4EC6');
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState<number | 'group' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setName('');
      setEmoji('💬');
      setColor('#8E4EC6');
      setPicked([]);
      setError(null);
    }
  }, [open, initialMode]);

  const others = members.filter((m) => m.id !== user?.id);
  const reachable = others.filter((m) => !m.managed);

  const openConv = (c: Conversation) => {
    void qc.invalidateQueries({ queryKey: keys.conversations });
    onClose();
    navigate(`/messages/${c.id}`);
  };

  const startDirect = async (userId: number) => {
    setBusy(userId);
    try {
      openConv(await api.post<Conversation>('/messages/conversations', { kind: 'direct', user_id: userId }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const createGroup = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give your group a name');
    if (!picked.length) return setError('Pick at least one person');
    setError(null);
    setBusy('group');
    try {
      const c = await api.post<Conversation>('/messages/conversations', { kind: 'group', name: name.trim(), emoji, color, member_ids: picked });
      toast.success(`“${c.title}” created`);
      openConv(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New conversation"
      description={mode === 'direct' ? 'Send a private message to someone in your family.' : 'Create a group chat for a few family members.'}
      icon={
        <span className="flex size-10 items-center justify-center rounded-2xl" style={{ backgroundColor: `color-mix(in oklab, ${ACCENT} 14%, transparent)`, color: ACCENT }}>
          <MessageCircle size={20} />
        </span>
      }
      footer={
        mode === 'group' ? (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="new-group" loading={busy === 'group'} icon={Users}>Create group</Button>
          </>
        ) : undefined
      }
    >
      <SegmentedControl
        block
        aria-label="Conversation type"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'direct', label: 'Direct message', icon: MessageCircle },
          { value: 'group', label: 'New group', icon: Users },
        ]}
        className="mb-5"
      />
      {mode === 'direct' ? (
        others.length === 0 ? (
          <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">Invite someone to your family first — then you can message them here.</p>
        ) : (
          <ul className="-mx-2 space-y-1">
            {others.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={m.managed || busy !== null}
                  onClick={() => startDirect(m.id)}
                  className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <Avatar user={m} size="lg" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-fg">{m.nickname || m.name}</span>
                    <span className="block text-[13px] text-muted">{m.managed ? "Doesn't have their own login yet" : m.role === 'admin' ? 'Admin' : m.role === 'child' ? 'Child' : 'Member'}</span>
                  </span>
                  {busy === m.id ? (
                    <span className="size-5 animate-spin rounded-full border-2 border-border border-t-primary" />
                  ) : !m.managed ? (
                    <ChevronRight size={18} className="text-subtle" />
                  ) : (
                    <Badge tone="neutral" size="sm">No login</Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <form id="new-group" onSubmit={createGroup} className="space-y-5" noValidate>
          <div className="flex items-end gap-3">
            <span
              className="flex size-14 shrink-0 items-center justify-center rounded-[18px] text-[28px]"
              style={{ background: `linear-gradient(145deg, color-mix(in oklab, ${color} 22%, var(--surface)), color-mix(in oklab, ${color} 38%, var(--surface)))`, border: `1px solid color-mix(in oklab, ${color} 30%, transparent)` }}
              aria-hidden
            >
              {emoji}
            </span>
            <Field label="Group name" required className="flex-1" error={error && !name.trim() ? error : undefined}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Weekend plans" autoFocus />
            </Field>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-fg">Icon</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Group icon">
              {GROUP_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={emoji === e}
                  aria-label={e}
                  onClick={() => setEmoji(e)}
                  className={cn(
                    'flex size-10 items-center justify-center rounded-xl text-xl transition active:scale-90',
                    emoji === e ? 'bg-primary-soft ring-2 ring-primary' : 'bg-surface-2 hover:bg-surface-3',
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-fg">Color</p>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-fg">People</p>
            {reachable.length ? (
              <MemberPicker multiple value={picked} onChange={setPicked} members={reachable} showAll aria-label="Group members" />
            ) : (
              <p className="text-sm text-muted">Nobody else with a login yet.</p>
            )}
            <p className="mt-2 text-xs text-subtle">You're included automatically.</p>
          </div>
          {error && name.trim() && <p className="text-sm font-medium text-danger" role="alert">{error}</p>}
        </form>
      )}
    </Modal>
  );
}
