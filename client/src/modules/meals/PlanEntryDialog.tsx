import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { BookOpen, Check, Clock, ExternalLink, Heart, Minus, PenLine, Plus, Search, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDate } from '../../lib/format';
import { Button, EmptyState, Field, Input, MemberPicker, Modal, SegmentedControl, Select, Skeleton, toast } from '../../ui';
import { useRecipes, type PlanEntry, type PlanInput, type Slot } from './api';
import { RecipeArt } from './RecipeArt';
import { ACCENT, ACCENT_SOLID, SLOTS, capitalize, fmtMinutes, slotMeta } from './utils';

export interface PlanDialogState {
  entry?: PlanEntry;
  date: string;
  slot: Slot;
  recipeId?: number;
}

const QUICK_IDEAS = ['Leftovers', 'Eating out', 'Takeout', 'Sandwiches', 'Breakfast for dinner', 'Fend for yourself'];

export function PlanEntryDialog({ state, onClose, onDeleted }: {
  state: PlanDialogState | null;
  onClose: () => void;
  onDeleted?: (entry: PlanEntry) => void;
}) {
  return (
    <Modal
      open={!!state}
      onClose={onClose}
      size="lg"
      title={state?.entry ? 'Edit meal' : `Plan ${slotMeta(state?.slot ?? 'dinner').label.toLowerCase()}`}
      description={state ? fmtDate(state.date, 'EEEE, MMMM d') : undefined}
      bodyClassName="pt-1"
      footer={state ? <DialogFooter state={state} onClose={onClose} onDeleted={onDeleted} /> : null}
    >
      {state && <PlanForm key={`${state.entry?.id ?? 'new'}-${state.date}-${state.slot}-${state.recipeId ?? ''}`} state={state} onClose={onClose} />}
    </Modal>
  );
}

// The footer lives outside the form body; it submits the form via form="meal-plan-form".
function DialogFooter({ state, onClose, onDeleted }: { state: PlanDialogState; onClose: () => void; onDeleted?: (e: PlanEntry) => void }) {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const entry = state.entry;
  const canEdit = !entry || role !== 'child' || entry.created_by === user?.id;
  const remove = async () => {
    if (!entry) return;
    setRemoving(true);
    try {
      await api.del(`/meals/plan/${entry.id}`);
      await qc.invalidateQueries({ queryKey: ['meals'] });
      onDeleted?.(entry);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <>
      {entry && canEdit && (
        <Button variant="ghost" icon={Trash2} onClick={remove} loading={removing} className="text-danger hover:text-danger sm:mr-auto">
          Remove
        </Button>
      )}
      <Button variant="secondary" onClick={onClose} className="max-sm:hidden">
        Cancel
      </Button>
      {canEdit && (
        <Button type="submit" form="meal-plan-form" style={{ backgroundColor: ACCENT_SOLID }} className="text-white hover:brightness-105">
          {entry ? 'Save' : 'Add to plan'}
        </Button>
      )}
    </>
  );
}

function PlanForm({ state, onClose }: { state: PlanDialogState; onClose: () => void }) {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const entry = state.entry;
  const canEdit = !entry || role !== 'child' || entry.created_by === user?.id;
  const recipesQ = useRecipes({ sort: 'popular' });
  const [mode, setMode] = useState<'recipe' | 'text'>(entry ? (entry.recipe_id ? 'recipe' : 'text') : 'recipe');
  const [recipeId, setRecipeId] = useState<number | null>(entry?.recipe_id ?? state.recipeId ?? null);
  const [title, setTitle] = useState(entry && !entry.recipe_id ? entry.title : '');
  const [date, setDate] = useState(entry?.date ?? state.date);
  const [slot, setSlot] = useState<Slot>(entry?.slot ?? state.slot);
  const [cookId, setCookId] = useState<number | null>(entry?.cook_id ?? null);
  const [note, setNote] = useState(entry?.note ?? '');
  const [servings, setServings] = useState<number | null>(entry?.servings ?? null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const recipes = recipesQ.data ?? [];
  const selected = recipes.find((r) => r.id === recipeId) ?? null;

  // Open on "Something else" when the family has no recipes yet.
  useEffect(() => {
    if (!entry && recipesQ.isSuccess && recipes.length === 0) setMode('text');
  }, [entry, recipesQ.isSuccess, recipes.length]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? recipes.filter((r) => r.title.toLowerCase().includes(needle) || r.tags.some((t) => t.includes(needle)))
      : recipes;
    const suggested = (r: (typeof recipes)[number]) => (r.tags.includes(slot) ? 0 : 1) + (r.favorite ? 0 : 0.5);
    return [...filtered].sort((a, b) => suggested(a) - suggested(b));
  }, [recipes, q, slot]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    setError(null);
    const body: PlanInput = { date, slot, note: note.trim() || null, cook_id: cookId, servings: mode === 'recipe' ? servings : null };
    if (mode === 'recipe') {
      if (!recipeId) return setError('Pick a recipe — or switch to "Something else".');
      body.recipe_id = recipeId;
    } else {
      if (!title.trim()) return setError("Type what you're having.");
      body.recipe_id = null;
      body.title = title.trim();
    }
    setSaving(true);
    try {
      const saved = entry ? await api.patch<PlanEntry>(`/meals/plan/${entry.id}`, body) : await api.post<PlanEntry>('/meals/plan', body);
      await qc.invalidateQueries({ queryKey: ['meals'] });
      toast.success(entry ? 'Meal updated' : `${saved.title} added`, {
        description: `${fmtDate(saved.date, 'EEEE')} · ${slotMeta(saved.slot).label}`,
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form id="meal-plan-form" onSubmit={submit} className="flex flex-col gap-5" aria-busy={saving}>
      {!canEdit && (
        <p className="rounded-xl bg-warning-soft px-3.5 py-2.5 text-sm text-warning-soft-fg">
          Someone else planned this meal — ask a grown-up to change it.
        </p>
      )}
      <fieldset disabled={!canEdit || saving} className="flex min-w-0 flex-col gap-5">
        <SegmentedControl
          block
          aria-label="What are you having?"
          value={mode}
          onChange={(v) => { setMode(v); setError(null); }}
          options={[
            { value: 'recipe', label: 'From recipes', icon: BookOpen },
            { value: 'text', label: 'Something else', icon: PenLine },
          ]}
        />

        {mode === 'recipe' ? (
          <div className="flex flex-col gap-2.5">
            <Input
              icon={Search}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search recipes"
              aria-label="Search recipes"
            />
            <div role="listbox" aria-label="Recipes" className="-mx-1 flex max-h-[min(40vh,320px)] flex-col gap-1 overflow-y-auto px-1 py-0.5 scrollbar-thin">
              {recipesQ.isLoading &&
                Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 p-2">
                    <Skeleton className="size-12 rounded-xl" />
                    <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
                  </div>
                ))}
              {recipesQ.isSuccess && list.length === 0 && (
                <EmptyState
                  compact
                  icon={BookOpen}
                  accent={ACCENT}
                  title={recipes.length ? 'No recipes match' : 'No recipes yet'}
                  description={recipes.length ? 'Try another word, or plan something else.' : 'Add recipes in the Recipes tab — or just type a meal.'}
                  action={<Button size="sm" variant="soft" onClick={() => { setMode('text'); setTitle(q); }}>Type a meal instead</Button>}
                />
              )}
              {list.map((r) => {
                const on = r.id === recipeId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => { setRecipeId(r.id); setError(null); }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-2xl border p-2 text-left transition',
                      on ? 'border-transparent ring-2' : 'border-transparent hover:bg-surface-2',
                    )}
                    style={on ? { backgroundColor: `color-mix(in oklab, ${ACCENT} 10%, transparent)`, ['--tw-ring-color' as string]: ACCENT } : undefined}
                  >
                    <RecipeArt recipe={r} className="size-12 shrink-0" rounded="rounded-xl" iconSize={22} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[15px] font-semibold text-fg">{r.title}</span>
                        {r.favorite && <Heart size={13} className="shrink-0 fill-[#E5484D] text-[#E5484D]" aria-label="Favorite" />}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                        {r.total_minutes > 0 && <span className="inline-flex items-center gap-1"><Clock size={12} />{fmtMinutes(r.total_minutes)}</span>}
                        {r.tags.slice(0, 2).map((t) => <span key={t} className="truncate">{capitalize(t)}</span>)}
                      </span>
                    </span>
                    <span
                      className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition', on ? 'border-transparent text-white' : 'border-border-strong')}
                      style={on ? { backgroundColor: ACCENT_SOLID } : undefined}
                      aria-hidden
                    >
                      {on && <Check size={14} strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <Field label="What's on the menu?" required>
              <Input value={title} onChange={(e) => { setTitle(e.target.value); setError(null); }} placeholder="e.g. Leftover curry" maxLength={120} autoFocus />
            </Field>
            <div className="flex flex-wrap gap-2" aria-label="Quick ideas">
              {QUICK_IDEAS.map((idea) => (
                <button
                  key={idea}
                  type="button"
                  onClick={() => setTitle(idea)}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-muted transition hover:border-border-strong hover:text-fg"
                >
                  {idea}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Day">
            <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} required />
          </Field>
          <Field label="Meal">
            <Select value={slot} onChange={(e) => setSlot(e.target.value as Slot)} options={SLOTS.map((s) => ({ value: s.id, label: s.label }))} />
          </Field>
        </div>

        <Field label="Who's cooking?" hint="They'll get a notification.">
          <MemberPicker value={cookId} onChange={setCookId} />
        </Field>

        <div className={cn('grid gap-4', mode === 'recipe' && selected && 'sm:grid-cols-[1fr_auto]')}>
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Make extra for lunches" maxLength={300} />
          </Field>
          {mode === 'recipe' && selected && (
            <Field label="Servings">
              <div className="flex h-11 items-center gap-1 rounded-xl border border-border bg-surface px-1">
                <button type="button" aria-label="Fewer servings" className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" onClick={() => setServings(Math.max(1, (servings ?? selected.servings) - 1))}>
                  <Minus size={16} />
                </button>
                <span className="w-10 text-center text-[15px] font-semibold tabular-nums text-fg" aria-live="polite">{servings ?? selected.servings}</span>
                <button type="button" aria-label="More servings" className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" onClick={() => setServings(Math.min(100, (servings ?? selected.servings) + 1))}>
                  <Plus size={16} />
                </button>
              </div>
            </Field>
          )}
        </div>
      </fieldset>

      {entry?.recipe_id && (
        <Link to={`/meals/recipes/${entry.recipe_id}`} onClick={onClose} className="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-primary hover:underline">
          <ExternalLink size={15} /> Open recipe
        </Link>
      )}
      {error && <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger-soft-fg">{error}</p>}
    </form>
  );
}
