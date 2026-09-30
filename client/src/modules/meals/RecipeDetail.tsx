import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CalendarPlus, ChefHat, Clock, ExternalLink, Flame, Minus, Pencil, Plus, SearchX, Trash2, Users, UtensilsCrossed } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtDate, fmtDay, toDateKey } from '../../lib/format';
import { Avatar, Badge, Button, Card, Checkbox, EmptyState, Menu, PageHeader, Skeleton, SkeletonText, buttonClass, toast, useConfirm } from '../../ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRecipe, useToggleFavorite, type Recipe, type Slot } from './api';
import { PlanEntryDialog, type PlanDialogState } from './PlanEntryDialog';
import { FavoriteButton, MemberStack, RecipeArt } from './RecipeArt';
import { RecipeEditor } from './RecipeEditor';
import { ACCENT, ACCENT_SOLID, amountLabel, ingredientName, capitalize, fmtMinutes, slotMeta, weekStart } from './utils';

export function RecipeDetail() {
  const id = Number(useParams().id);
  const recipeQ = useRecipe(id);

  if (recipeQ.isLoading) return <DetailSkeleton />;
  if (recipeQ.isError || !recipeQ.data) {
    const notFound = recipeQ.error instanceof ApiError && (recipeQ.error.status === 404 || recipeQ.error.status === 400);
    return (
      <div>
        <PageHeader title="Recipe" back="/meals/recipes" />
        <EmptyState
          icon={notFound ? SearchX : UtensilsCrossed}
          accent={ACCENT}
          title={notFound ? 'Recipe not found' : "Couldn't load this recipe"}
          description={notFound ? 'It may have been deleted by someone in your family.' : errorMessage(recipeQ.error)}
          action={<Link to="/meals/recipes" className={buttonClass('secondary')}>Back to recipes</Link>}
        />
      </div>
    );
  }
  return <Detail recipe={recipeQ.data} />;
}

function guessSlot(r: Recipe): Slot {
  for (const s of ['breakfast', 'lunch', 'snack'] as Slot[]) if (r.tags.includes(s)) return s;
  return 'dinner';
}

function Detail({ recipe: r }: { recipe: Recipe }) {
  const { members, user, role } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const fav = useToggleFavorite();
  const [servings, setServings] = useState(r.servings);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [editOpen, setEditOpen] = useState(false);
  const [plan, setPlan] = useState<PlanDialogState | null>(null);
  const factor = servings / r.servings;
  const canEdit = role !== 'child' || r.created_by === user?.id;
  const author = members.find((m) => m.id === r.created_by);
  const lovers = members.filter((m) => r.favorited_by.includes(m.id));

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${r.title}?`,
      message: r.upcoming.length ? 'It stays on the meal plan as a plain meal name, but the ingredients and steps are gone for good.' : 'The ingredients and steps will be gone for good.',
      confirmLabel: 'Delete recipe',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/meals/recipes/${r.id}`);
      qc.removeQueries({ queryKey: ['meals', 'recipe', r.id] });
      await qc.invalidateQueries({ queryKey: ['meals'] });
      toast.success(`${r.title} deleted`);
      navigate('/meals/recipes');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const toggleFav = () => fav.mutate({ id: r.id, favorite: !r.favorite }, { onError: (e) => toast.error(errorMessage(e)) });

  // Only show times we know; "Total" is redundant when there is just one of prep/cook.
  const stats = [
    { label: 'Prep', value: fmtMinutes(r.prep_minutes), icon: Clock },
    { label: 'Cook', value: fmtMinutes(r.cook_minutes), icon: Flame },
    { label: 'Total', value: r.prep_minutes && r.cook_minutes ? fmtMinutes(r.total_minutes) : '', icon: ChefHat },
    { label: 'Serves', value: String(r.servings), icon: Users },
  ].filter((s) => s.value);

  return (
    <div>
      <PageHeader
        title={<span className="line-clamp-3 whitespace-normal break-words">{r.title}</span>}
        back="/meals/recipes"
        documentTitle={r.title}
        actions={
          <>
            <FavoriteButton active={r.favorite} onToggle={toggleFav} title={r.title} visualClassName="border border-border bg-surface dark:bg-surface" />
            {canEdit && (
              <Menu
                label="Recipe actions"
                items={[
                  { label: 'Edit recipe', icon: Pencil, onSelect: () => setEditOpen(true) },
                  { label: 'Add to meal plan', icon: CalendarPlus, onSelect: () => setPlan({ date: toDateKey(), slot: guessSlot(r), recipeId: r.id }) },
                  'divider',
                  { label: 'Delete recipe', icon: Trash2, danger: true, onSelect: remove },
                ]}
              />
            )}
          </>
        }
      />

      <Card padding="none" className="mb-6 overflow-hidden">
        <div className="grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <RecipeArt recipe={r} className="aspect-[4/3] w-full md:aspect-auto md:min-h-[340px]" rounded="rounded-none" iconSize={72} />
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            {r.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {r.tags.map((t) => (
                  <Link key={t} to={`/meals/recipes?tag=${encodeURIComponent(t)}`} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Badge color={ACCENT} size="md">{capitalize(t)}</Badge>
                  </Link>
                ))}
              </div>
            )}
            {r.description && <p className="text-[15px] leading-relaxed text-muted">{r.description}</p>}
            {stats.length >= 3 ? (
              <dl className="grid gap-2" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
                {stats.map((s) => (
                  <div key={s.label} className="flex flex-col items-center gap-1 rounded-2xl bg-surface-2 px-1 py-3 text-center">
                    <s.icon size={17} style={{ color: ACCENT }} aria-hidden />
                    <dd className="text-[13px] font-bold leading-tight text-fg sm:text-sm">{s.value}</dd>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-subtle">{s.label}</dt>
                  </div>
                ))}
              </dl>
            ) : (
              // Few facts: compact chips instead of big, mostly empty tiles.
              <dl className="flex flex-wrap gap-2">
                {stats.map((s) => (
                  <div key={s.label} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-[13px]">
                    <s.icon size={15} style={{ color: ACCENT }} aria-hidden />
                    <dt className="text-muted">{s.label}</dt>
                    <dd className="font-bold text-fg">{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="flex flex-wrap gap-2">
              <Link
                to={`/meals/recipes/${r.id}/cook?servings=${servings}`}
                className={buttonClass('primary', 'lg', 'flex-1 text-white hover:brightness-105 sm:flex-none')}
                style={{ backgroundColor: '#C2410C' }}
              >
                <ChefHat size={18} /> Start cooking
              </Link>
              <Button variant="secondary" size="lg" icon={CalendarPlus} className="flex-1 sm:flex-none" onClick={() => setPlan({ date: toDateKey(), slot: guessSlot(r), recipeId: r.id })}>
                Add to plan
              </Button>
            </div>
            <div className="mt-auto flex flex-col gap-2.5 border-t border-border pt-4 text-[13px] text-muted">
              {lovers.length > 0 && (
                <div className="flex items-center gap-2">
                  <MemberStack users={lovers} />
                  <span>Loved by {lovers.map((m) => (m.id === user?.id ? 'you' : firstName(m.name))).join(', ')}</span>
                </div>
              )}
              {r.upcoming.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>On the menu</span>
                  {r.upcoming.slice(0, 4).map((u) => (
                    <Link key={u.id} to={`/meals?week=${weekStart(u.date)}`} className="rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-semibold text-success-soft-fg hover:underline">
                      {fmtDay(u.date)} · {slotMeta(u.slot).label}
                    </Link>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {author && (
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar user={author} size="xs" /> Added by {author.id === user?.id ? 'you' : firstName(author.name)} · {fmtDate(r.created_at, 'MMM d, yyyy')}
                  </span>
                )}
                {r.source_url && (
                  <a href={r.source_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                    <ExternalLink size={13} /> Original recipe
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card className="lg:sticky lg:top-24">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-fg">Ingredients</h2>
              <p className="text-[13px] text-muted">{checked.size ? `${checked.size} of ${r.ingredients.length} gathered` : `${r.ingredients.length} items`}</p>
            </div>
            <div className="flex items-center gap-1 rounded-xl bg-surface-2 p-1" role="group" aria-label="Servings">
              <button type="button" aria-label="Fewer servings" disabled={servings <= 1} onClick={() => setServings((s) => Math.max(1, s - 1))} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg disabled:opacity-40">
                <Minus size={15} />
              </button>
              <span className="min-w-[4.5rem] text-center text-[13px] font-semibold text-fg" aria-live="polite">
                {servings} {servings === 1 ? 'serving' : 'servings'}
              </span>
              <button type="button" aria-label="More servings" disabled={servings >= 100} onClick={() => setServings((s) => Math.min(100, s + 1))} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg disabled:opacity-40">
                <Plus size={15} />
              </button>
            </div>
          </div>
          {r.ingredients.length ? (
            <ul className="-mx-1 flex flex-col">
              {r.ingredients.map((ing, i) => {
                const key = ing.id ?? i;
                const on = checked.has(key);
                const amount = amountLabel(ing, factor);
                return (
                  <li key={key} className="rounded-xl px-1 py-2 transition hover:bg-surface-2/60">
                    <Checkbox
                      checked={on}
                      shape="circle"
                      color={ACCENT_SOLID}
                      onChange={(v) => setChecked((prev) => { const n = new Set(prev); if (v) n.add(key); else n.delete(key); return n; })}
                      className="w-full"
                      label={
                        <span className={cn('transition', on && 'text-subtle line-through')}>
                          {amount && <strong className="font-semibold">{amount} </strong>}
                          {ingredientName(ing, factor)}
                        </span>
                      }
                      description={ing.note ?? undefined}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="py-4 text-sm text-muted">No ingredients listed.</p>
          )}
        </Card>

        <Card>
          <h2 className="mb-4 text-lg font-bold tracking-tight text-fg">Steps</h2>
          {r.steps.length ? (
            <ol className="flex flex-col gap-5">
              {r.steps.map((s, i) => (
                <li key={i} className="flex gap-4">
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-[15px] font-bold"
                    style={{ backgroundColor: `color-mix(in oklab, ${ACCENT} 14%, transparent)`, color: '#C2410C' }}
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <p className="pt-1.5 text-[15px] leading-relaxed text-fg"><span className="sr-only">Step {i + 1}: </span>{s}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No steps yet.{canEdit && <> <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setEditOpen(true)}>Add some</button></>}</p>
          )}
        </Card>
      </div>

      <RecipeEditor open={editOpen} onClose={() => setEditOpen(false)} recipe={r} />
      <PlanEntryDialog state={plan} onClose={() => setPlan(null)} />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading recipe">
      <Skeleton className="mb-6 h-9 w-64" />
      <Card padding="none" className="mb-6 overflow-hidden">
        <div className="grid md:grid-cols-2">
          <Skeleton className="aspect-[4/3] w-full rounded-none" />
          <div className="space-y-4 p-6">
            <Skeleton className="h-6 w-1/2" />
            <SkeletonText lines={3} />
            <div className="grid grid-cols-4 gap-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
