import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { BookOpen, CalendarCheck, Clock, Heart, Plus, Search, Users } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { fmtDay } from '../../lib/format';
import { useDebounce } from '../../lib/hooks';
import { Button, EmptyState, Fab, Input, Select, Skeleton, toast } from '../../ui';
import { errorMessage } from '../../lib/api';
import { useRecipes, useTags, useToggleFavorite, type RecipeSort, type RecipeSummary } from './api';
import { FavoriteButton, MemberStack, RecipeArt } from './RecipeArt';
import { RecipeEditor } from './RecipeEditor';
import { ACCENT, ACCENT_SOLID, capitalize, fmtMinutes } from './utils';

export function RecipeBox() {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') ?? '';
  const favorites = params.get('fav') === '1';
  const sort = (params.get('sort') as RecipeSort) || 'recent';
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounce(q.trim(), 250);
  const recipesQ = useRecipes({ q: debounced || undefined, tag: tag || undefined, favorites, sort });
  const tagsQ = useTags();
  const [editorOpen, setEditorOpen] = useState(false);
  const [allTags, setAllTags] = useState(false);
  const navigate = useNavigate();

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const recipes = recipesQ.data ?? [];
  const filtered = !!(debounced || tag || favorites);
  const chip = (active: boolean) =>
    cn(
      'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition sm:h-9',
      active ? 'border-transparent text-white shadow-xs' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-fg',
    );
  const activeStyle = { backgroundColor: '#C2410C' };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          icon={Search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search recipes…"
          title="Search by name, tag or ingredient"
          aria-label="Search recipes"
          className="min-w-0 flex-1 basis-40"
          type="search"
        />
        <Select
          aria-label="Sort recipes"
          value={sort}
          onChange={(e) => setParam('sort', e.target.value === 'recent' ? null : e.target.value)}
          className="w-auto"
          options={[
            { value: 'recent', label: 'Newest' },
            { value: 'popular', label: 'Family favorites' },
            { value: 'quick', label: 'Quickest' },
            { value: 'title', label: 'A–Z' },
          ]}
        />
        <Button icon={Plus} onClick={() => setEditorOpen(true)} style={{ backgroundColor: ACCENT_SOLID }} className="text-white hover:brightness-105 max-lg:hidden">
          New recipe
        </Button>
      </div>

      <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Filter recipes">
        <button type="button" aria-pressed={!tag && !favorites} className={chip(!tag && !favorites)} style={!tag && !favorites ? activeStyle : undefined} onClick={() => setParams(new URLSearchParams(sort !== 'recent' ? { sort } : {}), { replace: true })}>
          All
        </button>
        <button type="button" aria-pressed={favorites} className={chip(favorites)} style={favorites ? activeStyle : undefined} onClick={() => setParam('fav', favorites ? null : '1')}>
          <Heart size={14} className={cn(favorites && 'fill-current')} /> My favorites
        </button>
        {(tagsQ.data ?? []).filter((t, i) => allTags || i < 8 || t.tag === tag).map((t) => (
          <button key={t.tag} type="button" aria-pressed={tag === t.tag} className={chip(tag === t.tag)} style={tag === t.tag ? activeStyle : undefined} onClick={() => setParam('tag', tag === t.tag ? null : t.tag)}>
            {capitalize(t.tag)}
            <span className={cn('text-[11px] tabular-nums', tag === t.tag ? 'text-white/80' : 'text-subtle')}>{t.count}</span>
          </button>
        ))}
        {(tagsQ.data?.length ?? 0) > 8 && (
          <button type="button" className={chip(false)} aria-expanded={allTags} onClick={() => setAllTags((v) => !v)}>
            {allTags ? 'Fewer tags' : `+${(tagsQ.data?.length ?? 0) - 8} more`}
          </button>
        )}
      </div>

      {recipesQ.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4" role="status" aria-label="Loading recipes">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-border bg-surface">
              <Skeleton className="aspect-[4/3] w-full rounded-none" />
              <div className="space-y-2 p-3"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-3 w-1/2" /></div>
            </div>
          ))}
        </div>
      ) : recipesQ.isError ? (
        <EmptyState icon={BookOpen} accent={ACCENT} title="Couldn't load recipes" description={errorMessage(recipesQ.error)} action={<Button onClick={() => recipesQ.refetch()}>Try again</Button>} />
      ) : recipes.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={Search}
            accent={ACCENT}
            title="No recipes match"
            description={favorites && !debounced && !tag ? 'Tap the heart on a recipe to keep it here.' : 'Try a different search or filter.'}
            action={<Button variant="secondary" onClick={() => { setQ(''); setParams(new URLSearchParams(), { replace: true }); }}>Clear filters</Button>}
          />
        ) : (
          <EmptyState
            icon={BookOpen}
            accent={ACCENT}
            title="Start your family recipe box"
            description="Save the dishes everyone loves — with ingredients and steps — then plan them into the week in one tap."
            action={<Button icon={Plus} onClick={() => setEditorOpen(true)} style={{ backgroundColor: ACCENT_SOLID }} className="text-white">Add your first recipe</Button>}
          />
        )
      ) : (
        <div className={cn('grid grid-cols-2 gap-3 transition-opacity sm:gap-4 md:grid-cols-3 xl:grid-cols-4', recipesQ.isFetching && recipesQ.isPlaceholderData && 'opacity-60')}>
          {recipes.map((r) => <RecipeCard key={r.id} recipe={r} />)}
        </div>
      )}

      <Fab label="New recipe" accent={ACCENT_SOLID} onClick={() => setEditorOpen(true)} />
      <RecipeEditor open={editorOpen} onClose={() => setEditorOpen(false)} onSaved={(r) => navigate(`/meals/recipes/${r.id}`)} />
    </div>
  );
}

function RecipeCard({ recipe: r }: { recipe: RecipeSummary }) {
  const { members } = useAuth();
  const fav = useToggleFavorite();
  const lovers = members.filter((m) => r.favorited_by.includes(m.id));
  return (
    <Link
      to={`/meals/recipes/${r.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring animate-fade-in"
    >
      <div className="relative">
        <RecipeArt recipe={r} className="aspect-[4/3] w-full transition duration-300 group-hover:brightness-105" rounded="rounded-none" iconSize={44} />
        <FavoriteButton
          size="sm"
          title={r.title}
          active={r.favorite}
          className="absolute right-0.5 top-0.5"
          onToggle={() =>
            fav.mutate({ id: r.id, favorite: !r.favorite }, { onError: (e) => toast.error(errorMessage(e)) })
          }
        />
        {r.total_minutes > 0 && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] font-semibold text-white backdrop-blur">
            <Clock size={11} /> {fmtMinutes(r.total_minutes)}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3 sm:p-3.5">
        <h3 className="line-clamp-2 text-[14px] font-bold leading-snug text-fg sm:text-[15px]">{r.title}</h3>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1"><Users size={12} /> {r.servings}</span>
          {r.tags[0] && <span className="truncate">· {capitalize(r.tags[0])}</span>}
        </div>
        <div className="mt-auto flex min-h-6 items-center justify-between gap-2 pt-1">
          {lovers.length ? <MemberStack users={lovers} max={3} /> : <span />}
          {r.next_planned && (
            <span className="inline-flex items-center gap-1 truncate text-[11px] font-semibold text-success-soft-fg">
              <CalendarCheck size={12} /> {fmtDay(r.next_planned)}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
