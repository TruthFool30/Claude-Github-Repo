import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { fmtRelative } from '../lib/format';
import { useLive } from '../lib/live';
import type { Notification } from '../lib/types';
import { EmptyState, IconButton, Popover, SkeletonList, toast } from '../ui';
import { moduleMeta } from './moduleMeta';

interface NotificationsResponse {
  items: Notification[];
  unread: number;
}
const KEY = ['notifications'];

/** Bell icon with unread badge and a live dropdown panel. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isPending } = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<NotificationsResponse>('/notifications'),
    staleTime: 30_000,
  });

  useLive<Notification>(
    'notification',
    (e) => {
      if (e.type === 'notification' && e.payload) {
        const n = e.payload;
        toast.info(n.title, {
          description: n.body ?? undefined,
          action: n.link ? { label: 'View', onClick: () => navigate(n.link!) } : undefined,
        });
      }
    },
    { queryKey: KEY },
  );

  const markRead = async (ids?: number[]) => {
    qc.setQueryData<NotificationsResponse>(KEY, (old) =>
      old
        ? {
            items: old.items.map((n) => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)),
            unread: ids ? Math.max(0, old.unread - old.items.filter((n) => ids.includes(n.id) && !n.read_at).length) : 0,
          }
        : old,
    );
    await api.post('/notifications/read', ids ? { ids } : {}).catch(() => qc.invalidateQueries({ queryKey: KEY }));
  };

  const unread = data?.unread ?? 0;
  return (
    <>
      <IconButton
        ref={anchor}
        icon={Bell}
        label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        badge={unread || undefined}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        align="end"
        role="dialog"
        aria-label="Notifications"
        className="flex max-h-[min(560px,calc(100dvh-96px))] w-[min(390px,calc(100vw-16px))] flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-bold text-fg">Notifications</h2>
            {unread > 0 && <span className="rounded-full bg-danger px-1.5 py-px text-[11px] font-bold text-white tabular">{unread}</span>}
          </div>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => markRead()}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-primary hover:bg-primary-soft"
            >
              <CheckCheck size={15} /> Mark all read
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 scrollbar-thin">
          {isPending ? (
            <SkeletonList rows={3} className="p-3" />
          ) : !data?.items.length ? (
            <EmptyState compact icon={BellOff} title="You're all caught up" description="New activity for you will show up here." />
          ) : (
            data.items.map((n) => {
              const meta = moduleMeta(n.module);
              const Icon = meta.icon;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!n.read_at) markRead([n.id]);
                    setOpen(false);
                    if (n.link) navigate(n.link);
                  }}
                  className={cn(
                    'relative flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-surface-2',
                    !n.read_at && 'bg-primary-soft/40',
                  )}
                >
                  <span
                    className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl"
                    style={{ backgroundColor: `color-mix(in oklab, ${meta.accent} 15%, transparent)`, color: meta.accent }}
                  >
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-sm leading-snug text-fg', !n.read_at ? 'font-semibold' : 'font-medium')}>{n.title}</span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-muted">{n.body}</span>}
                    <span className="mt-1 block text-xs text-subtle">
                      {meta.label} · {fmtRelative(n.created_at)}
                    </span>
                  </span>
                  {!n.read_at && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                </button>
              );
            })
          )}
        </div>
      </Popover>
    </>
  );
}
