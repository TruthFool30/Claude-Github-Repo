import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { Check, ChevronLeft, ChevronRight, ListChecks, ListOrdered, Minus, PartyPopper, Plus, Timer, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/hooks';
import { useToastPlacement } from '../../lib/shell';
import { Button, Checkbox, PageSpinner, SegmentedControl, toast } from '../../ui';
import { useRecipe, type Recipe } from './api';
import { RecipeArt } from './RecipeArt';
import { ACCENT, amountLabel, findTimer, fmtClock, ingredientName } from './utils';

const DEEP = '#C2410C';

interface RunningTimer { id: number; recipeId: number; label: string; endsAt: number; total: number; done: boolean }

// Running timers survive closing cook mode (and reloads) so a pot on the stove is never forgotten.
const TIMERS_KEY = 'hearth-meals-timers';
function loadTimers(): RunningTimer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TIMERS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    // Drop timers that finished more than an hour ago.
    return raw.filter((t) => t && typeof t.endsAt === 'number' && t.endsAt > Date.now() - 36e5);
  } catch {
    return [];
  }
}
function saveTimers(list: RunningTimer[]) {
  try {
    localStorage.setItem(TIMERS_KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

/** Full-screen, distraction-free cooking view: big steps, checkable ingredients, step timers. */
export default function CookMode() {
  const id = Number(useParams().id);
  const recipeQ = useRecipe(id);
  if (recipeQ.isLoading) return <PageSpinner />;
  if (!recipeQ.data) return <Navigate to={`/meals/recipes/${id}`} replace />;
  return createPortal(<Cook recipe={recipeQ.data} />, document.body);
}

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.28);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
  } catch {
    /* audio not available */
  }
}

function Cook({ recipe: r }: { recipe: Recipe }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialServings = Math.min(100, Math.max(1, Number(params.get('servings')) || r.servings));
  const [servings, setServings] = useState(initialServings);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<'steps' | 'ingredients'>('steps');
  const [timers, setTimers] = useState<RunningTimer[]>(() => loadTimers().filter((t) => t.recipeId === r.id));
  const [, tick] = useState(0);
  const stepRef = useRef<HTMLHeadingElement>(null);
  const total = r.steps.length;
  const factor = servings / r.servings;
  useDocumentTitle(`Cooking ${r.title}`);

  const close = useCallback(() => navigate(`/meals/recipes/${r.id}`), [navigate, r.id]);
  const next = useCallback(() => {
    if (step < total - 1) setStep((s) => s + 1);
    else setDone(true);
  }, [step, total]);
  const prev = useCallback(() => {
    if (done) setDone(false);
    else setStep((s) => Math.max(0, s - 1));
  }, [done]);

  // Keyboard: ← → / Space / Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // Only text-entry controls keep their keys; checkboxes/buttons don't use ← →.
      if (el.closest('textarea, select, [contenteditable="true"]')) return;
      if (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type)) return;
      if (el.closest('[role=dialog]') !== el.closest('[aria-label^="Cook mode"]')) return; // another overlay on top
      if (e.key === 'ArrowRight' || (e.key === ' ' && !el.closest('button'))) { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, close]);

  // Keep the screen awake while cooking (where supported). The browser drops the lock whenever the
  // tab is hidden, so take it again when we come back; never leak a lock that resolves after unmount.
  useEffect(() => {
    type Lock = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Lock> } };
    if (!nav.wakeLock) return;
    let lock: Lock | null = null;
    let cancelled = false;
    let pending = false;
    const acquire = async () => {
      if (cancelled || pending || lock || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const l = await nav.wakeLock!.request('screen');
        if (cancelled) l.release().catch(() => {});
        else {
          lock = l;
          (l as unknown as EventTarget).addEventListener?.('release', () => { if (lock === l) lock = null; });
        }
      } catch {
        /* denied / not allowed right now */
      } finally {
        pending = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
      lock = null;
    };
  }, []);

  // Toasts go to the top while cooking so they never cover Back/Next/Finish.
  useToastPlacement('top');

  // Lock page scroll behind the overlay.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => { stepRef.current?.focus({ preventScroll: true }); }, [step, done]);

  // Timers: persist every change (keeping other recipes' timers), tick while any is running, and fire
  // the beep/toast from the interval itself — never inside a state updater (StrictMode runs those twice).
  const timersRef = useRef(timers);
  timersRef.current = timers;
  useEffect(() => {
    saveTimers([...loadTimers().filter((t) => t.recipeId !== r.id), ...timers]);
  }, [timers, r.id]);
  const running = timers.some((t) => !t.done);
  useEffect(() => {
    if (!running) return;
    const check = () => {
      const now = Date.now();
      const finished = timersRef.current.filter((t) => !t.done && t.endsAt <= now);
      if (finished.length) {
        beep();
        for (const t of finished) toast.success(`Timer done: ${t.label}`, { duration: 10000 });
        const ids = new Set(finished.map((t) => t.id));
        setTimers((ts) => ts.map((t) => (ids.has(t.id) ? { ...t, done: true } : t)));
      }
      tick((n) => n + 1);
    };
    check();
    const h = setInterval(check, 500);
    return () => clearInterval(h);
  }, [running]);

  const startTimer = (seconds: number, label: string) =>
    setTimers((ts) => [...ts, { id: Date.now(), recipeId: r.id, label, endsAt: Date.now() + seconds * 1000, total: seconds, done: false }]);

  const current = r.steps[step] ?? '';
  const timer = findTimer(current);
  const progress = total ? ((done ? total : step + 1) / total) * 100 : 100;

  const ingredients = (
    <div className="flex flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-bold text-fg">Ingredients</h2>
        <div className="flex items-center gap-1 rounded-xl bg-surface-2 p-1" role="group" aria-label="Servings">
          <button type="button" aria-label="Fewer servings" onClick={() => setServings((s) => Math.max(1, s - 1))} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg"><Minus size={15} /></button>
          <span className="min-w-[3.5rem] text-center text-[13px] font-semibold text-fg" aria-live="polite">{servings} serv.</span>
          <button type="button" aria-label="More servings" onClick={() => setServings((s) => Math.min(100, s + 1))} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg"><Plus size={15} /></button>
        </div>
      </div>
      <ul className="flex flex-col gap-1">
        {r.ingredients.map((ing, i) => {
          const key = ing.id ?? i;
          const on = checked.has(key);
          const amount = amountLabel(ing, factor);
          return (
            <li key={key} className={cn('rounded-2xl px-3 py-3 transition', on ? 'bg-surface-2/50' : 'bg-surface-2')}>
              <Checkbox
                size="lg"
                shape="circle"
                color={DEEP}
                checked={on}
                onChange={(v) => setChecked((p) => { const n = new Set(p); if (v) n.add(key); else n.delete(key); return n; })}
                className="w-full"
                label={
                  <span className={cn('text-[17px] leading-snug', on && 'text-subtle line-through')}>
                    {amount && <strong className="font-bold">{amount} </strong>}
                    {ingredientName(ing, factor)}
                    {ing.note && <span className="text-muted">, {ing.note}</span>}
                  </span>
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg animate-fade-in" role="dialog" aria-modal="true" aria-label={`Cook mode: ${r.title}`}>
      {/* Top bar */}
      <header className="shrink-0 border-b border-border bg-surface pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <RecipeArt recipe={r} className="size-10 shrink-0 max-sm:hidden" rounded="rounded-xl" iconSize={18} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: DEEP }}>Cook mode</p>
            <h1 className="truncate text-[15px] font-bold text-fg sm:text-base">{r.title}</h1>
          </div>
          {timers.length > 0 && (
            <div className="flex max-w-[50%] gap-1.5 overflow-x-auto scrollbar-none" aria-label="Timers" aria-live="polite">
              {timers.map((t) => {
                const left = Math.max(0, (t.endsAt - Date.now()) / 1000);
                return (
                  <button
                    key={t.id}
                    type="button"
                    title={`${t.label} — tap to dismiss`}
                    onClick={() => setTimers((ts) => ts.filter((x) => x.id !== t.id))}
                    className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-bold tabular-nums', t.done ? 'animate-pulse text-white' : 'bg-warning-soft text-warning-soft-fg')}
                    style={t.done ? { backgroundColor: '#1d7a4d' } : undefined}
                    aria-label={t.done ? `Timer ${t.label} finished, dismiss` : `Timer ${t.label}, ${fmtClock(left)} left, dismiss`}
                  >
                    {t.done ? <Check size={14} /> : <Timer size={14} />}
                    {t.done ? 'Done' : fmtClock(left)}
                  </button>
                );
              })}
            </div>
          )}
          <button type="button" onClick={close} aria-label="Exit cook mode" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg transition hover:bg-surface-3">
            <X size={20} />
          </button>
        </div>
        <div className="h-1 bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done ? total : step + 1} aria-label="Progress">
          <div className="h-full transition-all duration-500" style={{ width: `${progress}%`, backgroundColor: ACCENT }} />
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 pt-3 lg:hidden">
        <SegmentedControl
          block
          aria-label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'steps', label: `Steps (${total})`, icon: ListOrdered },
            { value: 'ingredients', label: `Ingredients (${r.ingredients.length})`, icon: ListChecks },
          ]}
        />
      </div>

      <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 gap-6 overflow-hidden px-4 lg:grid-cols-[360px_1fr]">
        <aside className={cn('min-h-0 overflow-y-auto py-5 scrollbar-thin', tab === 'ingredients' ? 'block' : 'hidden lg:block')}>{ingredients}</aside>

        <main className={cn('flex min-h-0 flex-col overflow-y-auto py-5', tab === 'steps' ? 'flex' : 'hidden lg:flex')}>
          {done ? (
            <div className="m-auto flex max-w-lg flex-col items-center text-center animate-scale-in">
              <span className="mb-5 flex size-20 items-center justify-center rounded-[28%] text-white shadow-lift" style={{ backgroundColor: DEEP }}>
                <PartyPopper size={38} />
              </span>
              <h2 ref={stepRef} tabIndex={-1} className="text-3xl font-bold tracking-tight text-fg outline-none">Time to eat!</h2>
              <p className="mt-2 text-[17px] text-muted">You made {r.title}. Enjoy it together.</p>
              <div className="mt-7 flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="lg" onClick={() => { setDone(false); setStep(0); }}>Start over</Button>
                <Button size="lg" onClick={close} style={{ backgroundColor: DEEP }} className="text-white">Finish</Button>
              </div>
            </div>
          ) : total === 0 ? (
            <p className="m-auto text-lg text-muted">This recipe has no steps yet.</p>
          ) : (
            <div className="flex flex-1 flex-col">
              <p className="text-sm font-bold uppercase tracking-wider" style={{ color: DEEP }}>
                Step {step + 1} <span className="text-subtle">of {total}</span>
              </p>
              <h2
                key={step}
                ref={stepRef}
                tabIndex={-1}
                aria-live="polite"
                className="mt-3 text-[26px] font-semibold leading-[1.35] tracking-tight text-fg outline-none animate-fade-in sm:text-[32px] lg:text-[36px]"
              >
                {current}
              </h2>
              {timer && (
                <button
                  type="button"
                  onClick={() => startTimer(timer.seconds, `Step ${step + 1} · ${timer.label}`)}
                  className="mt-6 inline-flex items-center gap-2 self-start rounded-full px-4 py-2.5 text-[15px] font-bold transition hover:brightness-95"
                  style={{ backgroundColor: `color-mix(in oklab, ${ACCENT} 16%, transparent)`, color: DEEP }}
                >
                  <Timer size={18} /> Start {fmtClock(timer.seconds)} timer
                </button>
              )}
              <ol className="mt-auto flex flex-wrap gap-1.5 pt-8" aria-label="Jump to step">
                {r.steps.map((_, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => setStep(i)}
                      aria-label={`Go to step ${i + 1}`}
                      aria-current={i === step ? 'step' : undefined}
                      className={cn('flex size-9 items-center justify-center rounded-full text-[13px] font-bold transition', i === step ? 'text-white' : i < step ? 'bg-surface-3 text-fg' : 'bg-surface-2 text-muted hover:text-fg')}
                      style={i === step ? { backgroundColor: DEEP } : undefined}
                    >
                      {i < step ? <Check size={14} /> : i + 1}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </main>
      </div>

      {!done && total > 0 && (
        <footer className="shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
            <Button variant="secondary" size="lg" icon={ChevronLeft} onClick={prev} disabled={step === 0} className="flex-1 sm:flex-none">
              Back
            </Button>
            <span className="hidden flex-1 text-center text-[13px] text-subtle sm:block">Use ← → keys to move between steps</span>
            <Button size="lg" iconRight={step === total - 1 ? Check : ChevronRight} onClick={next} style={{ backgroundColor: DEEP }} className="flex-[2] text-white hover:brightness-110 sm:flex-none sm:px-8">
              {step === total - 1 ? 'Done' : 'Next step'}
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}
