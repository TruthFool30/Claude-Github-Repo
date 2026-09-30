import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Plus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { moduleMeta } from '../../layout/moduleMeta';
import { Button, EmptyState, Field, Input, Modal, Select, Skeleton, buttonClass, toast } from '../../ui';

interface ListSummary {
  id: number;
  name: string;
  type?: string;
}

/**
 * "Add to a list" quick action. Uses the Lists module's public API (GET /api/lists and
 * POST /api/lists/:id/items/bulk) and degrades to a friendly link when Lists isn't available.
 */
export function QuickAddItem({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accent = moduleMeta('lists').accent;
  const lists = useQuery({
    queryKey: ['wall', 'quick-lists'],
    queryFn: async () => {
      const data = await api.get<unknown>('/lists');
      if (!Array.isArray(data)) return null; // Lists module not installed / different shape
      return (data as ListSummary[]).filter((l) => l && typeof l.id === 'number' && typeof l.name === 'string');
    },
    enabled: open,
    retry: false,
    staleTime: 10_000,
  });
  const [listId, setListId] = useState<string>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText('');
  }, [open]);
  useEffect(() => {
    const data = lists.data;
    if (data?.length && !data.some((l) => String(l.id) === listId)) {
      setListId(String((data.find((l) => l.type === 'shopping') ?? data[0]).id));
    }
  }, [lists.data, listId]);

  const available = !!lists.data?.length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !listId) return;
    setBusy(true);
    try {
      await api.post(`/lists/${listId}/items/bulk`, { items: [{ text: t }] });
      const name = lists.data?.find((l) => String(l.id) === listId)?.name ?? 'the list';
      toast.success(`Added to ${name}`, { action: { label: 'Open', onClick: () => navigate(`/lists/${listId}`) } });
      void qc.invalidateQueries({ queryKey: ['lists'] });
      void qc.invalidateQueries({ queryKey: ['wall', 'dashboard'] });
      setText('');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add to a list"
      size="sm"
      icon={<ListChecks size={18} style={{ color: accent }} />}
      footer={
        available ? (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="wall-quick-item" icon={Plus} loading={busy} disabled={!text.trim()}>Add</Button>
          </>
        ) : undefined
      }
    >
      {lists.isPending ? (
        <div className="flex flex-col gap-3" aria-label="Loading lists" role="status">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : available ? (
        <form id="wall-quick-item" onSubmit={submit} className="flex flex-col gap-4">
          <Field label="List">
            <Select value={listId} onChange={(e) => setListId(e.target.value)} options={lists.data!.map((l) => ({ value: String(l.id), label: l.name }))} />
          </Field>
          <Field label="Item">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Oat milk" autoFocus maxLength={200} />
          </Field>
        </form>
      ) : (
        <EmptyState
          compact
          icon={ListChecks}
          accent={accent}
          title={lists.data ? 'No lists yet' : "Lists aren't available yet"}
          description={lists.data ? 'Create a grocery or to-do list first, then add items from here.' : 'Open Lists to create shared groceries, chores and to-dos.'}
          action={<Link to="/lists" onClick={onClose} className={buttonClass('primary', 'md')}>Open lists</Link>}
        />
      )}
    </Modal>
  );
}
