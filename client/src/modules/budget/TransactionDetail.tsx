// Transaction detail sheet + list row + delete-with-undo helper.
import { useState } from 'react';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { CalendarDays, FileText, Paperclip, Pencil, Repeat, StickyNote, Trash2, UserRound } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth, useMember } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDate, fmtRelative, firstName } from '../../lib/format';
import { Avatar, Button, Lightbox, Modal, Skeleton, toast } from '../../ui';
import { keys, useCanManage, useMoney, type Transaction, type TxPage } from './api';
import { Amount, CategoryIcon, UNCATEGORIZED } from './shared';

export const txTitle = (t: Transaction) => t.description || t.category?.name || (t.kind === 'income' ? 'Income' : 'Expense');

/** Remove optimistically from every cached list, with an Undo toast that restores it. */
export function useDeleteTransaction() {
  const qc = useQueryClient();
  return async (t: Transaction) => {
    // Lists are either plain arrays (recent) or infinite pages ({ pages: [{ items }] }).
    type Cached = Transaction[] | InfiniteData<TxPage> | undefined;
    const lists = qc.getQueriesData<Cached>({ queryKey: keys.transactionsRoot });
    qc.setQueriesData<Cached>({ queryKey: keys.transactionsRoot }, (old) => {
      if (!old) return old;
      if (Array.isArray(old)) return old.filter((x) => x.id !== t.id);
      return { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.filter((x) => x.id !== t.id) })) };
    });
    try {
      await api.del(`/budget/transactions/${t.id}`);
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success('Transaction deleted', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await api.post(`/budget/transactions/${t.id}/restore`);
              qc.invalidateQueries({ queryKey: keys.all });
              toast.info('Transaction restored');
            } catch (e) {
              toast.error(errorMessage(e));
            }
          },
        },
      });
    } catch (e) {
      for (const [key, data] of lists) qc.setQueryData(key, data);
      toast.error(errorMessage(e));
    }
  };
}

export function useCanEditTx() {
  const { user } = useAuth();
  const canManage = useCanManage();
  return (t: Transaction) => canManage || t.created_by === user?.id;
}

export function TransactionRow({ t, onOpen, showDate }: { t: Transaction; onOpen: (t: Transaction) => void; showDate?: boolean }) {
  const { fmt } = useMoney();
  const member = useMember(t.paid_by);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(t)}
        className="group flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
        aria-label={`${txTitle(t)}, ${t.kind === 'income' ? 'income' : 'expense'} ${fmt(t.amount)}, ${fmtDate(t.date)}`}
      >
        <CategoryIcon category={t.category} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-fg">{txTitle(t)}</span>
            {t.recurring_id && <Repeat size={13} className="shrink-0 text-subtle" aria-label="Recurring" />}
            {t.receipt_url && <Paperclip size={13} className="shrink-0 text-subtle" aria-label="Has receipt" />}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
            <span className="truncate">{t.category?.name ?? UNCATEGORIZED.name}</span>
            {showDate && <span className="shrink-0">· {fmtDate(t.date, 'MMM d')}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <Amount kind={t.kind} value={t.amount} fmt={fmt} className="text-[15px]" />
          {member && <Avatar user={member} size="xs" title={`Paid by ${member.name}`} />}
        </div>
      </button>
    </li>
  );
}

export function TransactionDetail({
  id, initial, onClose, onEdit,
}: { id: number | null; initial?: Transaction | null; onClose: () => void; onEdit: (t: Transaction) => void }) {
  const { fmt } = useMoney();
  const canEdit = useCanEditTx();
  const del = useDeleteTransaction();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: keys.transaction(id ?? 0),
    queryFn: () => api.get<Transaction>(`/budget/transactions/${id}`),
    enabled: !!id,
    initialData: initial && initial.id === id ? initial : undefined,
  });
  const t = data;
  const payer = useMember(t?.paid_by);
  const creator = useMember(t?.created_by);
  const isPdf = !!t?.receipt_url && /\.pdf$/i.test(t.receipt_url);

  return (
    <>
      <Modal
        open={!!id}
        onClose={onClose}
        size="sm"
        title={t ? txTitle(t) : 'Transaction'}
        footer={
          t && canEdit(t) ? (
            <>
              <Button
                variant="ghost"
                icon={Trash2}
                className="text-danger hover:bg-danger-soft hover:text-danger"
                onClick={() => {
                  onClose();
                  void del(t);
                }}
              >
                Delete
              </Button>
              <Button icon={Pencil} onClick={() => onEdit(t)}>Edit</Button>
            </>
          ) : undefined
        }
      >
        {isLoading && !t ? (
          <div className="flex flex-col gap-3 py-2">
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : isError || !t ? (
          <p className="py-6 text-center text-sm text-muted">This transaction was deleted or can't be found.</p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <CategoryIcon category={t.category} size="lg" />
              <div className="min-w-0">
                <Amount kind={t.kind} value={t.amount} fmt={fmt} className="text-3xl font-bold tracking-tight" />
                <div className="mt-0.5 text-sm text-muted">{t.category?.name ?? UNCATEGORIZED.name} · {t.kind === 'income' ? 'Income' : 'Expense'}</div>
              </div>
            </div>
            <dl className="divide-y divide-border rounded-2xl border border-border">
              <Row icon={CalendarDays} label="Date" value={fmtDate(t.date, 'EEEE, MMMM d, yyyy')} />
              <Row
                icon={UserRound}
                label={t.kind === 'income' ? 'Received by' : 'Paid by'}
                value={payer ? (<span className="inline-flex items-center gap-2"><Avatar user={payer} size="xs" />{payer.name}</span>) : '—'}
              />
              {t.recurring_id && <Row icon={Repeat} label="Recurring" value="Monthly bill payment" />}
              {t.notes && <Row icon={StickyNote} label="Notes" value={<span className="whitespace-pre-wrap">{t.notes}</span>} />}
            </dl>
            {t.receipt_url && (
              <div>
                <div className="mb-2 text-[13px] font-semibold text-fg">Receipt</div>
                {isPdf ? (
                  <a href={t.receipt_url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-2xl border border-border p-3 text-sm font-medium text-primary hover:bg-surface-2">
                    <FileText size={18} /> Open receipt (PDF)
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => setLightbox(0)}
                    className="block overflow-hidden rounded-2xl border border-border transition hover:shadow-lift focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
                    aria-label="View receipt full size"
                  >
                    <img src={t.receipt_url} alt="Receipt" className="max-h-64 w-full bg-surface-2 object-contain" />
                  </button>
                )}
              </div>
            )}
            <p className={cn('text-xs text-subtle')}>
              Added {creator ? `by ${firstName(creator.name)} ` : ''}{fmtRelative(t.created_at)}
              {t.updated_at !== t.created_at ? ` · edited ${fmtRelative(t.updated_at)}` : ''}
            </p>
          </div>
        )}
      </Modal>
      {t?.receipt_url && !isPdf && (
        <Lightbox images={[{ src: t.receipt_url, alt: 'Receipt', caption: txTitle(t) }]} index={lightbox} onClose={() => setLightbox(null)} onIndexChange={setLightbox} download />
      )}
    </>
  );
}

function Row({ icon: Icon, label, value }: { icon: typeof CalendarDays; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <Icon size={17} className="mt-0.5 shrink-0 text-subtle" aria-hidden />
      <dt className="w-24 shrink-0 text-[13px] text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm font-medium text-fg">{value}</dd>
    </div>
  );
}
