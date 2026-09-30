import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ClipboardPaste, Plus, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button, ColorPicker, Field, ImageUploader, Input, Modal, Textarea, fileForm, toast } from '../../ui';
import { useTags, type Ingredient, type Recipe, type RecipeInput } from './api';
import { RecipeArt } from './RecipeArt';
import { ACCENT, ACCENT_SOLID, RECIPE_COLORS, RECIPE_ICONS, UNIT_SUGGESTIONS, capitalize, fmtQty, parseAmount, parseIngredientLine } from './utils';

interface Row extends Ingredient { key: number }
let seq = 0;
const newRow = (i?: Partial<Ingredient>): Row => ({ key: ++seq, quantity: null, unit: null, name: '', note: null, ...i });
interface StepRow { key: number; text: string }
const newStep = (text = ''): StepRow => ({ key: ++seq, text });

export function RecipeEditor({ open, onClose, recipe, onSaved }: {
  open: boolean;
  onClose: () => void;
  recipe?: Recipe;
  onSaved?: (r: Recipe) => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="xl"
      title={recipe ? 'Edit recipe' : 'New recipe'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving} className="max-sm:hidden">Cancel</Button>
          <Button type="submit" form="recipe-form" loading={saving} style={{ backgroundColor: ACCENT_SOLID }} className="text-white hover:brightness-105">
            {recipe ? 'Save changes' : 'Save recipe'}
          </Button>
        </>
      }
    >
      {open && <EditorForm recipe={recipe} onClose={onClose} onSaved={onSaved} setSaving={setSaving} />}
    </Modal>
  );
}

function EditorForm({ recipe, onClose, onSaved, setSaving }: {
  recipe?: Recipe; onClose: () => void; onSaved?: (r: Recipe) => void; setSaving: (b: boolean) => void;
}) {
  const qc = useQueryClient();
  const tagsQ = useTags();
  const [title, setTitle] = useState(recipe?.title ?? '');
  const [description, setDescription] = useState(recipe?.description ?? '');
  const [servings, setServings] = useState(String(recipe?.servings ?? 4));
  const [prep, setPrep] = useState(String(recipe?.prep_minutes ?? ''));
  const [cook, setCook] = useState(String(recipe?.cook_minutes ?? ''));
  const [tags, setTags] = useState<string[]>(recipe?.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [icon, setIcon] = useState(recipe?.icon ?? 'utensils');
  const [color, setColor] = useState(recipe?.color ?? ACCENT);
  const [sourceUrl, setSourceUrl] = useState(recipe?.source_url ?? '');
  const [rows, setRows] = useState<Row[]>(() => (recipe?.ingredients.length ? recipe.ingredients.map((i) => newRow(i)) : [newRow(), newRow(), newRow()]));
  const [steps, setSteps] = useState<StepRow[]>(() => (recipe?.steps.length ? recipe.steps.map((s) => newStep(s)) : [newStep(), newStep()]));
  const [paste, setPaste] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const focusKey = useRef<number | null>(null);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);
  useEffect(() => {
    if (focusKey.current == null) return;
    document.querySelector<HTMLInputElement>(`[data-focus-key="${focusKey.current}"]`)?.focus();
    focusKey.current = null;
  });

  const shownPhoto = photo?.url ?? (removePhoto ? null : recipe?.photo_url ?? null);

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '').toLowerCase();
    if (!t) return;
    if (t.length > 30) return setErrors((e) => ({ ...e, tags: 'Tags can be at most 30 characters' }));
    if (!tags.includes(t)) {
      if (tags.length >= 12) return setErrors((e) => ({ ...e, tags: 'At most 12 tags' }));
      setTags([...tags, t]);
    }
    setTagDraft('');
    setErrors(({ tags: _t, ...rest }) => rest);
  };
  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagDraft);
    } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
      setTags(tags.slice(0, -1));
    }
  };

  const setRow = (key: number, patch: Partial<Ingredient>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRowAfter = (key?: number) => {
    const row = newRow();
    focusKey.current = row.key;
    setRows((rs) => {
      const i = key == null ? rs.length - 1 : rs.findIndex((r) => r.key === key);
      return [...rs.slice(0, i + 1), row, ...rs.slice(i + 1)];
    });
  };
  const applyPaste = () => {
    const parsed = (paste ?? '').split('\n').map(parseIngredientLine).filter((x): x is Ingredient => !!x);
    if (!parsed.length) return setPaste(null);
    setRows((rs) => [...rs.filter((r) => r.name.trim()), ...parsed.map((p) => newRow(p))]);
    setPaste(null);
    toast.success(`Added ${parsed.length} ingredient${parsed.length === 1 ? '' : 's'}`);
  };

  const moveStep = (i: number, dir: -1 | 1) =>
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Give your recipe a name';
    const sv = Number(servings);
    if (!Number.isInteger(sv) || sv < 1 || sv > 100) errs.servings = '1–100';
    const pm = prep === '' ? 0 : Number(prep);
    const cm = cook === '' ? 0 : Number(cook);
    if (!Number.isInteger(pm) || pm < 0 || pm > 2880) errs.prep = 'Minutes';
    if (!Number.isInteger(cm) || cm < 0 || cm > 2880) errs.cook = 'Minutes';
    const badRow = rows.find((r) => !r.name.trim() && (r.quantity != null || r.unit));
    if (badRow) errs.ingredients = 'Every ingredient with an amount needs a name';
    if (sourceUrl.trim() && !/^https?:\/\//i.test(sourceUrl.trim())) errs.source = 'Links start with http:// or https://';
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.querySelector<HTMLElement>('#recipe-form [aria-invalid="true"]')?.focus();
      return;
    }
    const pendingTag = tagDraft.trim() ? [...new Set([...tags, tagDraft.trim().toLowerCase()])] : tags;
    const body: RecipeInput = {
      title: title.trim(),
      description: description.trim() || null,
      servings: sv,
      prep_minutes: pm,
      cook_minutes: cm,
      tags: pendingTag,
      icon,
      color,
      source_url: sourceUrl.trim() || null,
      ingredients: rows.filter((r) => r.name.trim()).map(({ quantity, unit, name, note }) => ({ quantity, unit: unit?.trim() || null, name: name.trim(), note: note?.trim() || null })),
      steps: steps.map((s) => s.text.trim()).filter(Boolean),
    };
    setSaving(true);
    try {
      let saved = recipe ? await api.patch<Recipe>(`/meals/recipes/${recipe.id}`, body) : await api.post<Recipe>('/meals/recipes', body);
      try {
        if (photo) saved = await api.upload<Recipe>(`/meals/recipes/${saved.id}/photo`, fileForm(photo.file));
        else if (removePhoto && recipe?.photo_url) saved = await api.del<Recipe>(`/meals/recipes/${saved.id}/photo`);
      } catch (err) {
        toast.error(`Recipe saved, but the photo failed: ${errorMessage(err)}`);
      }
      qc.setQueryData(['meals', 'recipe', saved.id], saved);
      await qc.invalidateQueries({ queryKey: ['meals'] });
      toast.success(recipe ? 'Recipe updated' : `${saved.title} added to your recipes`);
      onClose();
      onSaved?.(saved);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const suggestions = (tagsQ.data ?? []).map((t) => t.tag).filter((t) => !tags.includes(t) && (!tagDraft || t.includes(tagDraft.toLowerCase()))).slice(0, 8);
  const sectionTitle = 'text-[13px] font-bold uppercase tracking-wide text-subtle';

  return (
    <form id="recipe-form" onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <div className="grid gap-5 md:grid-cols-[280px_1fr]">
        <div className="order-last flex flex-col gap-3 md:order-none">
          <ImageUploader
            aspect="4 / 3"
            value={shownPhoto}
            label="Photo"
            hint="Optional — without one we'll use the icon below."
            onSelect={(file) => {
              setPhoto({ file, url: URL.createObjectURL(file) });
              setRemovePhoto(false);
            }}
            onRemove={() => { setPhoto(null); setRemovePhoto(true); }}
          />
          {!shownPhoto && (
            <div className="flex flex-col gap-2.5 rounded-2xl border border-border p-3">
              <div className="flex items-center gap-3">
                <RecipeArt recipe={{ title, photo_url: null, icon, color }} className="size-14 shrink-0" iconSize={26} />
                <span className="text-[13px] text-muted">Pick an icon and color for the card.</span>
              </div>
              <div className="grid grid-cols-10 gap-1 md:grid-cols-7" role="radiogroup" aria-label="Recipe icon">
                {Object.entries(RECIPE_ICONS).map(([key, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={icon === key}
                    aria-label={key.replace('-', ' ')}
                    onClick={() => setIcon(key)}
                    className={cn('flex aspect-square items-center justify-center rounded-lg transition', icon === key ? 'text-white' : 'text-muted hover:bg-surface-2 hover:text-fg')}
                    style={icon === key ? { backgroundColor: '#C2410C' } : undefined}
                  >
                    <Icon size={17} />
                  </button>
                ))}
              </div>
              <ColorPicker value={color} onChange={setColor} colors={RECIPE_COLORS} size="sm" />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Recipe name" required error={errors.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Grandma's lasagna" maxLength={120} autoFocus={!recipe} />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What makes it special?" rows={3} autoGrow maxLength={2000} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Servings" error={errors.servings}>
              <Input type="number" inputMode="numeric" min={1} max={100} value={servings} onChange={(e) => setServings(e.target.value)} />
            </Field>
            <Field label="Prep (min)" error={errors.prep}>
              <Input type="number" inputMode="numeric" min={0} value={prep} onChange={(e) => setPrep(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Cook (min)" error={errors.cook}>
              <Input type="number" inputMode="numeric" min={0} value={cook} onChange={(e) => setCook(e.target.value)} placeholder="0" />
            </Field>
          </div>
          <Field label="Tags" hint="Press Enter to add — e.g. dinner, vegetarian, quick" error={errors.tags}>
            <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-2 py-1.5 focus-within:border-primary focus-within:ring-4 focus-within:ring-ring/60">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-1 pl-2.5 pr-1 text-[13px] font-medium text-fg">
                  {capitalize(t)}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))} className="flex size-5 items-center justify-center rounded-full text-muted hover:bg-surface-3 hover:text-fg">
                    <X size={12} />
                  </button>
                </span>
              ))}
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={onTagKey}
                onBlur={() => tagDraft && addTag(tagDraft)}
                placeholder={tags.length ? '' : 'Add a tag'}
                aria-label="Add a tag"
                className="h-7 min-w-[6rem] flex-1 bg-transparent px-1 text-[15px] text-fg outline-none placeholder:text-subtle sm:text-sm"
              />
            </div>
          </Field>
          {suggestions.length > 0 && (
            <div className="-mt-2 flex flex-wrap gap-1.5">
              {suggestions.map((t) => (
                <button key={t} type="button" onClick={() => addTag(t)} className="rounded-full border border-dashed border-border-strong px-2.5 py-1 text-xs font-medium text-muted hover:border-solid hover:text-fg">
                  + {capitalize(t)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <section aria-labelledby="ing-title" className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 id="ing-title" className={sectionTitle}>Ingredients</h3>
          <Button type="button" size="sm" variant="ghost" icon={ClipboardPaste} onClick={() => setPaste(paste === null ? '' : null)}>
            {paste === null ? 'Paste a list' : 'Cancel paste'}
          </Button>
        </div>
        {paste !== null ? (
          <div className="flex flex-col gap-2 rounded-2xl bg-surface-2 p-3">
            <Textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={6}
              autoFocus
              aria-label="Paste ingredients, one per line"
              placeholder={'One per line, e.g.\n2 cups flour\n1 ½ tsp baking powder\n3 eggs, beaten'}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">
                {(paste ?? '').split('\n').filter((l) => l.trim()).length} lines · amounts and units are detected
              </span>
              <Button type="button" size="sm" onClick={applyPaste}>Add ingredients</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="hidden grid-cols-[76px_96px_1fr_1fr_36px] gap-2 px-1 text-xs font-semibold text-subtle sm:grid">
              <span>Amount</span><span>Unit</span><span>Ingredient</span><span>Note</span><span />
            </div>
            <ul className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <li key={r.key} className="grid grid-cols-[64px_80px_1fr_36px] gap-2 rounded-2xl sm:grid-cols-[76px_96px_1fr_1fr_36px]">
                  <Input
                    size="sm"
                    aria-label={`Amount for ingredient ${i + 1}`}
                    inputMode="decimal"
                    defaultValue={r.quantity != null ? fmtQty(r.quantity) : ''}
                    placeholder="1"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (!v) return setRow(r.key, { quantity: null });
                      // Accepts "1/2", "1 1/2", "½", "0.5", "1,5" and ranges ("2-3" keeps the upper bound).
                      const parsed = parseIngredientLine(`${v} x`);
                      setRow(r.key, { quantity: parsed?.quantity ?? parseAmount(v)?.value ?? null });
                    }}
                  />
                  <Input
                    size="sm"
                    aria-label={`Unit for ingredient ${i + 1}`}
                    list="meal-units"
                    value={r.unit ?? ''}
                    maxLength={20}
                    placeholder="cup"
                    onChange={(e) => setRow(r.key, { unit: e.target.value || null })}
                  />
                  <Input
                    size="sm"
                    data-focus-key={r.key}
                    aria-label={`Ingredient ${i + 1}`}
                    invalid={!!errors.ingredients && !r.name.trim() && (r.quantity != null || !!r.unit)}
                    value={r.name}
                    maxLength={120}
                    placeholder={['flour', 'eggs', 'milk'][i % 3]}
                    onChange={(e) => setRow(r.key, { name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addRowAfter(r.key);
                      }
                    }}
                  />
                  <Input
                    size="sm"
                    aria-label={`Note for ingredient ${i + 1}`}
                    value={r.note ?? ''}
                    maxLength={120}
                    placeholder="chopped"
                    className="col-span-3 max-sm:order-last sm:col-span-1"
                    onChange={(e) => setRow(r.key, { note: e.target.value || null })}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ingredient ${i + 1}`}
                    onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [newRow()]))}
                    className="flex size-9 items-center justify-center rounded-lg text-subtle transition hover:bg-danger-soft hover:text-danger"
                  >
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
            <datalist id="meal-units">{UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}</datalist>
            {errors.ingredients && <p role="alert" className="text-[13px] font-medium text-danger">{errors.ingredients}</p>}
            <Button type="button" variant="soft" size="sm" icon={Plus} onClick={() => addRowAfter()} className="self-start">
              Add ingredient
            </Button>
          </>
        )}
      </section>

      <section aria-labelledby="steps-title" className="flex flex-col gap-2.5">
        <h3 id="steps-title" className={sectionTitle}>Steps</h3>
        <ol className="flex flex-col gap-2.5">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-start gap-2">
              <span className="mt-2 flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white" style={{ backgroundColor: '#C2410C' }} aria-hidden>
                {i + 1}
              </span>
              <Textarea
                value={s.text}
                autoGrow
                rows={2}
                aria-label={`Step ${i + 1}`}
                placeholder={i === 0 ? 'e.g. Preheat the oven to 200°C / 400°F.' : 'Next…'}
                onChange={(e) => setSteps((all) => all.map((x) => (x.key === s.key ? { ...x, text: e.target.value } : x)))}
                className="min-w-0 flex-1"
              />
              <div className="flex shrink-0 flex-col">
                <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => moveStep(i, -1)} className="flex size-7 items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                  <ArrowUp size={15} />
                </button>
                <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} className="flex size-7 items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                  <ArrowDown size={15} />
                </button>
              </div>
              <button
                type="button"
                aria-label={`Remove step ${i + 1}`}
                onClick={() => setSteps((all) => (all.length > 1 ? all.filter((x) => x.key !== s.key) : [newStep()]))}
                className="mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-subtle hover:bg-danger-soft hover:text-danger"
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ol>
        <Button type="button" variant="soft" size="sm" icon={Plus} onClick={() => setSteps((all) => [...all, newStep()])} className="self-start">
          Add step
        </Button>
      </section>

      <Field label="Source link" hint="Optional — where the recipe came from" error={errors.source}>
        <Input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" maxLength={500} />
      </Field>
    </form>
  );
}
