import { useCallback, useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { MessageCirclePlus, MessagesSquare, Users } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, plural } from '../../lib/format';
import { useDocumentTitle, useIsDesktop } from '../../lib/hooks';
import { useHideBottomNav } from '../../lib/shell';
import { Avatar, Button, EmptyState, Fab, IconButton, Modal, PageHeader, toast } from '../../ui';
import { ChatView } from './ChatView';
import { ConversationInfo } from './ConversationInfo';
import { ConversationList } from './ConversationList';
import { NewConversationModal } from './NewConversation';
import { keys, useConversation, useConversations, useMessagesLive, useUnread } from './data';
import { ACCENT } from './parts';
import type { Conversation, RemovedEvent } from './types';
import mod from './index';

export default function MessagesPage() {
  return (
    <Routes>
      <Route index element={<Messages />} />
      <Route path=":id" element={<Messages />} />
      <Route path="*" element={<Messages />} />
    </Routes>
  );
}

function Messages() {
  const { id } = useParams();
  const activeId = id && /^\d+$/.test(id) ? Number(id) : null;
  const { user, members } = useAuth();
  const meId = user!.id;
  const isDesktop = useIsDesktop();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const convs = useConversations();
  const unread = useUnread();
  const [newOpen, setNewOpen] = useState<false | 'direct' | 'group'>(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const active = useConversation(activeId);

  // Phones: an open chat is full-screen — hide the bottom tab bar (composer sits flush at the bottom).
  useHideBottomNav(activeId !== null && !isDesktop);
  useEffect(() => setInfoOpen(false), [activeId]);
  // Esc closes the desktop details drawer (dialogs/popovers handle their own Esc first).
  useEffect(() => {
    if (!infoOpen || !isDesktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"], [role="menu"]')) setInfoOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [infoOpen, isDesktop]);

  const onRemoved = useCallback(
    (e: RemovedEvent) => {
      if (e.conversation_id !== activeId || e.by === meId) return;
      const title = qc.getQueryData<Conversation>(keys.conversation(e.conversation_id))?.title ?? 'the group';
      toast.info(e.reason === 'deleted' ? `“${title}” was deleted` : `You were removed from “${title}”`);
      navigate('/messages', { replace: true });
    },
    [activeId, meId, navigate, qc],
  );
  useMessagesLive({ meId, onRemoved });

  const total = unread.data?.total ?? 0;
  const subtitle = total ? `${plural(total, 'unread message')}` : mod.description;
  const showChat = activeId !== null;

  const startDirect = async (userId: number) => {
    try {
      const c = await api.post<Conversation>('/messages/conversations', { kind: 'direct', user_id: userId });
      void qc.invalidateQueries({ queryKey: keys.conversations });
      navigate(`/messages/${c.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };



  const list = (
    <ConversationList
      conversations={convs.data}
      loading={convs.isPending}
      activeId={activeId}
      meId={meId}
      onNew={() => setNewOpen('direct')}
      className={isDesktop ? 'h-full' : ''}
    />
  );

  const modal = <NewConversationModal open={!!newOpen} initialMode={newOpen || 'direct'} onClose={() => setNewOpen(false)} />;

  /* ----------------------------------------------------------------- mobile */
  if (!isDesktop) {
    if (showChat) {
      return (
        <div className="-mx-4 -mt-5 mb-[calc(-16px-env(safe-area-inset-bottom))] h-[calc(100dvh-var(--shell-chrome)+36px+env(safe-area-inset-bottom))] overflow-hidden bg-bg sm:-mx-6">
          <MobileTitle conv={active.data} />
          <ChatView conversationId={activeId} onInfo={() => setInfoOpen(true)} infoOpen={infoOpen} />
          <Modal open={infoOpen && !!active.data} onClose={() => setInfoOpen(false)} title="Conversation details" size="md" bodyClassName="px-0 sm:px-0">
            {active.data && <ConversationInfo conv={active.data} />}
          </Modal>
          {modal}
        </div>
      );
    }
    return (
      <div>
        <PageHeader title={mod.label} subtitle={subtitle} icon={mod.icon} accent={mod.accent} />
        <div className="-mx-4 sm:mx-0 sm:overflow-hidden sm:rounded-3xl sm:border sm:border-border sm:bg-surface sm:shadow-card">{list}</div>
        <Fab label="New chat" icon={MessageCirclePlus} accent={ACCENT} onClick={() => setNewOpen('direct')} />
        {modal}
      </div>
    );
  }

  /* ---------------------------------------------------------------- desktop */
  const others = members.filter((m) => m.id !== meId && !m.managed);
  return (
    <div className="-mb-8 -mt-4 flex h-[calc(100dvh-var(--shell-chrome)+48px)] min-h-[520px] flex-col">
      <DesktopTitle title={active.data ? `${active.data.title} · Messages` : mod.label} />
      <div className="relative grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] overflow-hidden rounded-3xl border border-border bg-surface shadow-card xl:grid-cols-[350px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-border">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl" style={{ backgroundColor: `color-mix(in oklab, ${ACCENT} 14%, transparent)`, color: ACCENT }} aria-hidden>
              <mod.icon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold leading-tight tracking-tight text-fg">{mod.label}</h1>
              <p className="truncate text-xs text-muted">{subtitle}</p>
            </div>
            <IconButton icon={MessageCirclePlus} label="New chat" variant="soft" onClick={() => setNewOpen('direct')} />
          </div>
          <div className="min-h-0 flex-1">{list}</div>
        </aside>
        <div className="relative min-h-0 bg-bg/40">
          {showChat ? (
            <>
              <ChatView conversationId={activeId} onInfo={() => setInfoOpen((o) => !o)} infoOpen={infoOpen} />
              {infoOpen && active.data && (
                <div className="absolute bottom-0 right-0 top-[61px] z-20 w-[320px] overflow-y-auto border-l border-border bg-surface shadow-pop animate-fade-in scrollbar-thin" role="complementary" aria-label="Conversation details">
                  <ConversationInfo conv={active.data} onClose={() => setInfoOpen(false)} className="min-h-full" />
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-8">
              <EmptyState
                icon={MessagesSquare}
                accent={ACCENT}
                title="Pick a conversation"
                description="Catch up with the family chat, or start a private message or group."
                action={
                  <div className="flex flex-col items-center gap-5">
                    <div className="flex gap-2">
                      <Button icon={MessageCirclePlus} onClick={() => setNewOpen('direct')}>New message</Button>
                      <Button variant="secondary" icon={Users} onClick={() => setNewOpen('group')}>New group</Button>
                    </div>
                    {others.length > 0 && (
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-subtle">Quick chat</span>
                        <div className="flex gap-3">
                          {others.slice(0, 6).map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => startDirect(m.id)}
                              className="group flex flex-col items-center gap-1 rounded-2xl p-1.5 transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
                              aria-label={`Message ${m.name}`}
                            >
                              <Avatar user={m} size="lg" className="transition group-hover:scale-105" />
                              <span className="text-xs font-medium text-muted">{firstName(m.name)}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                }
              />
            </div>
          )}
        </div>
      </div>
      {modal}
    </div>
  );
}

function DesktopTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

function MobileTitle({ conv }: { conv: Conversation | undefined }) {
  useDocumentTitle(conv ? `${conv.title} · Messages` : 'Messages');
  return <h1 className={cn('sr-only')}>{conv?.title ?? 'Messages'}</h1>;
}
