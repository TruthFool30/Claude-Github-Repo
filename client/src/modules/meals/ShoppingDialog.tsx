import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCopy, Info, ListChecks, ShoppingCart } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { plural } from '../../lib/format';
import { Badge, Button, Checkbox, EmptyState, Field, Modal, Select, SkeletonList, toast } from '../../ui';
// Lists' aisle data + classifier (read-only shared helpers) and our conservative name matcher.
import aisles from '../../../../shared/lists/aisles.json';
import { createClassifier } from '../../../../shared/lists/classify.js';
import { sameGrocery } from '../../../../shared/meals/match.js';
import { keys, type IngredientsResponse, type ShoppingItem } from './api';
import { ACCENT_SOLID, weekLabel } from './utils';

interface ShoppingList {
  id: number;
  name: string;
  type?: string;
}
interface ListItem {
  id: number;
  text: string;
  quantity: string | null;
  done: boolean;
}

const aisleOf = createClassifier(aisles).guessCategory;

/**
 * "Add the week's ingredients to a shopping list". Talks to the Lists module over HTTP only
 * (GET /api/lists?type=shopping, GET /api/lists/:id, POST /api/lists/:id/items/bulk) and degrades
 * gracefully when that module is unavailable: the aggregated list can always be copied.
 * Ingredients already open on the chosen list are flagged and unticked, so nothing is added twice.
 */
export function ShoppingDialog({ open, onClose, start }: { open: boolean; onClose: () => void; start: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ingredientsQ = useQuery({
    queryKey: keys.ingredients(start),
    queryFn: () => api.get<IngredientsResponse>(`/meals/plan/ingredients?start=${start}&days=7`),
    enabled: open,
  });
  const listsQ = useQuery({
    // Not under the 'meals' key: lists belong to another module.
    queryKey: ['meals-shopping-lists'],
    queryFn: async () => {
      const data = await api.get<unknown>('/lists?type=shopping');
      if (!Array.isArray(data)) throw new Error('Shopping lists are not available');
      return (data as ShoppingList[]).filter((l) => l && typeof l.id === 'number' && (!l.type || l.type === 'shopping'));
    },
    enabled: open,
    retry: false,
    staleTime: 0,
  });
  const [listId, setListId] = useState<number | null>(null);
  const listItemsQ = useQuery({
    queryKey: ['meals-shopping-list-items', listId],
    queryFn: async () => {
      const data = await api.get<{ items?: ListItem[] }>(`/lists/${listId}`);
      return Array.isArray(data?.items) ? data.items : [];
    },
    enabled: open && !!listId && listsQ.isSuccess,
    retry: false,
    staleTime: 0,
  });

  const items = useMemo(() => ingredientsQ.data?.items ?? [], [ingredientsQ.data]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Ingredients already open on the chosen list (matched by normalised name).
  const onList = useMemo(() => {
    const openItems = (listItemsQ.data ?? []).filter((it) => !it.done);
    const m = new Map<string, ListItem>();
    for (const i of items) {
      // "Cheddar" ≈ "Cheddar cheese", "Tortillas" ≈ "Small tortillas", "Avocados" ≈ "Avocado".
      const hit = openItems.find((it) => sameGrocery(it.text, i.label, aisleOf) || sameGrocery(it.text, i.name, aisleOf));
      if (hit) m.set(i.key, hit);
    }
    return m;
  }, [listItemsQ.data, items]);

  useEffect(() => {
    if (open) {
      setUnchecked(new Set());
      setAdded(new Set());
    }
  }, [open, start]);
  useEffect(() => {
    const lists = listsQ.data;
    if (lists?.length && !lists.some((l) => l.id === listId)) setListId(lists[0].id);
  }, [listsQ.data, listId]);
  // Whenever the chosen list's items arrive, untick what's already on it.
  const seeded = useRef<string>('');
  useEffect(() => {
    if (!listItemsQ.isSuccess) return;
    const sig = `${listId}:${listItemsQ.dataUpdatedAt}`;
    if (seeded.current === sig) return;
    seeded.current = sig;
    setUnchecked((prev) => new Set([...prev, ...onList.keys()]));
  }, [listItemsQ.isSuccess, listItemsQ.dataUpdatedAt, listId, onList]);

  const chosen = items.filter((i) => !unchecked.has(i.key) && !added.has(i.key));
  const groups = useMemo(() => {
    const m = new Map<string, ShoppingItem[]>();
    for (const it of items) m.set(it.category, [...(m.get(it.category) ?? []), it]);
    return [...m.entries()];
  }, [items]);
  const listsUnavailable = listsQ.isError;
  const noLists = listsQ.isSuccess && listsQ.data.length === 0;
  const alreadyCount = items.filter((i) => onList.has(i.key) && !added.has(i.key)).length;

  const toggle = (key: string, on: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  const copyText = async () => {
    const text = groups
      .map(([cat, list]) => {
        const lines = list.filter((i) => !unchecked.has(i.key)).map((i) => `- ${i.text}`);
        return lines.length ? `${cat}\n${lines.join('\n')}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(`Shopping for ${weekLabel(start)}\n\n${text}`);
      toast.success('Shopping list copied', { description: 'Paste it anywhere you like.' });
    } catch {
      toast.error('Could not copy — your browser blocked the clipboard');
    }
  };

  const add = async () => {
    if (!listId || !chosen.length) return;
    setSaving(true);
    const sending = chosen;
    try {
      // text = the name, quantity = the amount chip; Lists then doesn't re-parse the text.
      await api.post(`/lists/${listId}/items/bulk`, {
        items: sending.map((i) => ({ text: i.label, quantity: i.amount, category: i.category })),
      });
      const list = listsQ.data?.find((l) => l.id === listId);
      setAdded((prev) => new Set([...prev, ...sending.map((i) => i.key)]));
      qc.invalidateQueries({ queryKey: ['meals-shopping-list-items', listId] });
      toast.success(`Added ${plural(sending.length, 'item')} to ${list?.name ?? 'your list'}`, {
        action: { label: 'Open list', onClick: () => navigate(`/lists/${listId}`) },
      });
    } catch (e) {
      const msg = errorMessage(e);
      if (msg) toast.error(`Couldn't add to the list: ${msg}`, { description: 'You can still copy the list instead.' });
    } finally {
      setSaving(false);
    }
  };

  const data = ingredientsQ.data;
  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      dismissible={!saving}
      size="lg"
      icon={
        <span className="flex size-10 items-center justify-center rounded-2xl" style={{ backgroundColor: 'color-mix(in oklab, #F76B15 15%, transparent)', color: ACCENT_SOLID }}>
          <ShoppingCart size={20} />
        </span>
      }
      title="Shop for the week"
      description={data ? `${plural(data.meal_count, 'recipe')} planned for ${weekLabel(start)}` : weekLabel(start)}
      footer={
        <>
          <Button variant="secondary" icon={ClipboardCopy} onClick={copyText} disabled={!items.length}>
            Copy
          </Button>
          {!listsUnavailable && !noLists && (
            <Button
              icon={ListChecks}
              onClick={add}
              loading={saving}
              disabled={!chosen.length || !listId || listItemsQ.isLoading}
              style={{ backgroundColor: ACCENT_SOLID }}
              className="text-white hover:brightness-105"
            >
              {chosen.length ? `Add ${plural(chosen.length, 'item')}` : added.size ? 'All added' : 'Add items'}
            </Button>
          )}
        </>
      }
    >
      {ingredientsQ.isLoading ? (
        <SkeletonList rows={5} />
      ) : ingredientsQ.isError ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg">{errorMessage(ingredientsQ.error)}</p>
      ) : !items.length ? (
        <EmptyState
          compact
          icon={ShoppingCart}
          accent="#F76B15"
          title="No ingredients to add"
          description={data?.free_text.length ? 'This week only has meals without recipes. Add recipes to the plan to build a shopping list.' : 'Plan some recipes for this week first.'}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {listsQ.isLoading ? null : listsUnavailable ? (
            <Notice>
              Shopping lists aren't available right now, so we can't add these for you. Use <strong>Copy</strong> to paste the list anywhere.
            </Notice>
          ) : noLists ? (
            <Notice>
              You don't have a shopping list yet. <Link to="/lists" className="font-semibold underline" onClick={onClose}>Create one in Lists</Link>, or use <strong>Copy</strong>.
            </Notice>
          ) : (
            <Field label="Add to" hint={alreadyCount ? `${plural(alreadyCount, 'ingredient')} already on this list — left unticked.` : undefined}>
              <Select value={listId ?? ''} onChange={(e) => setListId(Number(e.target.value))} options={listsQ.data!.map((l) => ({ value: String(l.id), label: l.name }))} />
            </Field>
          )}

          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="text-muted">
              {chosen.length} of {items.length} selected · untick what you have
            </span>
            <button
              type="button"
              className="shrink-0 whitespace-nowrap font-semibold text-primary hover:underline"
              onClick={() => setUnchecked(unchecked.size ? new Set() : new Set(items.map((i) => i.key)))}
            >
              {unchecked.size ? 'Select all' : 'Select none'}
            </button>
          </div>

          <div className="flex flex-col gap-4">
            {groups.map(([cat, list]) => (
              <section key={cat} aria-label={cat}>
                <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-subtle">{cat}</h3>
                <ul className="divide-y divide-border rounded-2xl border border-border">
                  {list.map((it) => {
                    const isAdded = added.has(it.key);
                    const existing = onList.get(it.key);
                    return (
                      <li key={it.key} className="flex items-center gap-2 px-3.5 py-2.5">
                        <Checkbox
                          checked={!unchecked.has(it.key) && !isAdded}
                          disabled={isAdded}
                          onChange={(on) => toggle(it.key, on)}
                          color={ACCENT_SOLID}
                          shape="circle"
                          aria-label={it.text}
                          label={
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              {it.label}
                              {it.amount && <span className="rounded-md bg-surface-2 px-1.5 py-px text-xs font-semibold text-muted">{it.amount}</span>}
                            </span>
                          }
                          description={it.recipes.join(', ')}
                          className="min-w-0 flex-1"
                        />
                        {isAdded ? (
                          <Badge tone="success"><Check size={11} /> Added</Badge>
                        ) : existing ? (
                          <Badge tone="info">On list{existing.quantity ? ` · ${existing.quantity}` : ''}</Badge>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
          {!!data?.free_text.length && (
            <p className="text-xs text-muted">
              Not included (no recipe): {data.free_text.map((f) => f.title).join(', ')}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="flex gap-2.5 rounded-2xl bg-info-soft px-4 py-3 text-sm text-info-soft-fg">
      <Info size={18} className="mt-px shrink-0" />
      <p>{children}</p>
    </div>
  );
}
