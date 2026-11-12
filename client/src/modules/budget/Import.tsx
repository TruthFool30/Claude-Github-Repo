// Bank statement import (adults): upload → review rows → recurring bills → who can see it → done,
// plus the history of past imports with "Undo import". See CONTRACT.md (statement import).
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, CalendarClock, Check, CircleAlert, FileUp, History, KeyRound, Landmark, Lock, Repeat, ShieldAlert, Sparkles, Undo2, Upload, Wand2, X,
} from 'lucide-react';
import { ApiError, api, errorMessage } from '../../lib/api';
import { useMember } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtDate, fmtDay, fmtRelative, plural } from '../../lib/format';
import { useHideBottomNav } from '../../lib/shell';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, Menu, PageHeader, SegmentedControl, Select, SkeletonList, Switch, buttonClass, toast, useConfirm, VisibilityBadge, VisibilityPicker } from '../../ui';
import {
  BANK_LABEL, amountToInput, importLabel, parseAmount, previewImport, useCategories, useImports, useInvalidateAfterImport, useMoney,
  type Category, type CommitBody, type CommitResult, type ImportErrorCode, type ImportOut, type ImportPreview, type PreviewRow,
} from './api';
import { Amount, MoneyInput, merchantCase } from './shared';
import mod from './index';

const MAX_BYTES = 10 * 1024 * 1024; // CONTRACT: the preview endpoint's own 10 MB limit
const ACCEPT = '.pdf,.csv,.xlsx,.xls';
const PAGE = 60; // review rows rendered per "Show more"
const EXPORT_TIP = 'Download your transaction history as CSV from DBS digibank or UOB Personal Internet Banking and upload that instead.';

type Step = 'upload' | 'review' | 'recurring' | 'visibility' | 'done';
/** `pair`: also mark the paired row in the other account (only meaningful when the preview row has one). */
type Choice = { category_id: number | null; include: boolean; transfer: boolean; pair: boolean };
type BillDraft = { on: boolean; amount: string; day: string; category_id: number | null };
type Filter = 'all' | 'uncat' | 'dup' | 'income';

const ERRORS: Record<Exclude<ImportErrorCode, 'PASSWORD_REQUIRED' | 'BAD_PASSWORD'>, { title: string; body: string }> = {
  UNSUPPORTED: { title: "Hearth can't read this file yet", body: `It works with DBS/POSB and UOB statements (PDF, CSV or Excel .xlsx — older .xls files aren't supported). ${EXPORT_TIP}` },
  EMPTY: { title: 'No transactions found', body: 'The statement looks empty. Check the period you exported and try again.' },
  TOO_LARGE: { title: 'That file is too large', body: `Statements must be under 10 MB. ${EXPORT_TIP}` },
};

export default function ImportPage() {
  const [step, setStep] = useState<Step>('upload');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [bills, setBills] = useState<Record<string, BillDraft>>({});
  const [visibility, setVisibility] = useState<'adults' | 'private'>('adults');
  const [result, setResult] = useState<CommitResult | null>(null);
  const [committing, setCommitting] = useState(false);
  const initialChoices = useRef<Record<string, Choice>>({});
  const confirm = useConfirm();
  const invalidate = useInvalidateAfterImport();
  const top = useRef<HTMLDivElement>(null);
  useHideBottomNav(step === 'review' || step === 'recurring' || step === 'visibility');

  const go = (s: Step) => {
    setStep(s);
    top.current?.scrollIntoView({ block: 'start' });
    window.scrollTo({ top: 0 });
  };

  const onPreview = (p: ImportPreview) => {
    setPreview(p);
    const initial = Object.fromEntries(p.rows.map((r) => [r.row_id, { category_id: r.category_id, include: !r.duplicate, transfer: !!r.transfer, pair: !!r.pair }]));
    initialChoices.current = initial;
    setChoices(initial);
    setBills(Object.fromEntries(p.recurring.map((b) => [b.group, { on: !b.existing_bill_id, amount: amountToInput(b.amount), day: String(b.day_of_month), category_id: b.category_id }])));
    setVisibility('adults');
    go('review');
  };

  const reset = () => {
    setPreview(null);
    setResult(null);
    go('upload');
  };

  /** "Start over" throws the review away: ask first when something was changed. */
  const startOver = async () => {
    const dirty = Object.entries(choices).some(([id, c]) => {
      const o = initialChoices.current[id];
      return !o || o.category_id !== c.category_id || o.include !== c.include || o.transfer !== c.transfer || o.pair !== c.pair;
    });
    if (dirty && !(await confirm({ title: 'Start over?', message: 'Your category and selection changes for this statement will be lost.', confirmLabel: 'Start over', danger: true }))) return;
    reset();
  };

  const commit = async () => {
    if (!preview) return;
    const body: CommitBody = {
      visibility,
      rows: preview.rows.map((r) => {
        const { pair, ...c } = choices[r.row_id];
        // Decline the other account's row when this one isn't (or is no longer) a transfer, or the user said so.
        return { row_id: r.row_id, ...c, ...(r.pair && (!pair || !c.transfer || !c.include) ? { pair: false as const } : {}) };
      }),
      bills: preview.recurring.flatMap((b) => {
        const d = bills[b.group];
        if (!d?.on) return [];
        const amount = parseAmount(d.amount) ?? b.amount;
        const day = Math.min(31, Math.max(1, Number(d.day) || b.day_of_month));
        return [{ group: b.group, description: b.merchant ? merchantCase(b.merchant) : b.description, amount, day_of_month: day, category_id: d.category_id }];
      }),
    };
    setCommitting(true);
    try {
      const res = await api.post<CommitResult>(`/budget/imports/${encodeURIComponent(preview.token)}/commit`, body);
      setResult(res);
      void invalidate();
      go('done');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EXPIRED') {
        toast.error('This preview expired', { description: 'Previews are kept for 15 minutes. Upload the statement again.' });
        reset();
      } else toast.error(errorMessage(e));
    } finally {
      setCommitting(false);
    }
  };

  const stepNo = { upload: 1, review: 2, recurring: 3, visibility: 4, done: 4 }[step];
  const stepName = { upload: 'Upload', review: 'Review transactions', recurring: 'Repeating payments', visibility: 'Who can see it', done: 'Done' }[step];

  return (
    <div ref={top} className="scroll-mt-24 pb-6">
      <PageHeader
        title="Import statement"
        subtitle={step === 'done' ? 'All done' : `Step ${stepNo} of 4 · ${stepName}`}
        icon={FileUp}
        accent={mod.accent}
        back={step === 'upload' || step === 'done' ? '/budget/transactions' : undefined}
        documentTitle="Import statement · Budget"
      >
        {step !== 'done' && (
          <ol className="flex gap-1.5" aria-label="Progress">
            {[1, 2, 3, 4].map((n) => (
              <li key={n} className={cn('h-1.5 flex-1 rounded-full transition-colors', n <= stepNo ? 'bg-primary-solid' : 'bg-surface-3')}>
                <span className="sr-only">Step {n}{n === stepNo ? ' (current)' : n < stepNo ? ' (done)' : ''}</span>
              </li>
            ))}
          </ol>
        )}
      </PageHeader>

      {step === 'upload' && (
        <div className="flex flex-col gap-6">
          <UploadStep onPreview={onPreview} />
          <ImportHistory />
        </div>
      )}
      {step === 'review' && preview && (
        <ReviewStep preview={preview} choices={choices} setChoices={setChoices} onBack={startOver} onNext={() => go(preview.recurring.length ? 'recurring' : 'visibility')} />
      )}
      {step === 'recurring' && preview && <RecurringStep preview={preview} bills={bills} setBills={setBills} onBack={() => go('review')} onNext={() => go('visibility')} />}
      {step === 'visibility' && preview && (
        <Card className="mx-auto flex max-w-xl flex-col gap-5">
          <VisibilityPicker stacked value={visibility} onChange={setVisibility} options={['adults', 'private'] as const} what="these transactions" />
          <p className="text-xs text-muted">
            Children never see imported transactions. You can change who sees a single transaction later from its edit screen.
          </p>
          <ImportSummary preview={preview} choices={choices} bills={Object.values(bills).filter((b) => b.on).length} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" icon={ArrowLeft} onClick={() => go(preview.recurring.length ? 'recurring' : 'review')} disabled={committing}>Back</Button>
            <Button icon={Check} loading={committing} onClick={commit}>Import</Button>
          </div>
        </Card>
      )}
      {step === 'done' && result && <DoneStep result={result} onAgain={reset} />}
    </div>
  );
}

// ---- step 1: upload ---------------------------------------------------------------------------

function UploadStep({ onPreview }: { onPreview: (p: ImportPreview) => void }) {
  const insecure = typeof window !== 'undefined' && !window.isSecureContext;
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState<null | 'required' | 'bad'>(null);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [insecureOk, setInsecureOk] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pwInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needPassword) pwInput.current?.focus();
  }, [needPassword]);

  const send = async (f: File, pw?: string, force = false) => {
    if (f.size > MAX_BYTES) {
      setError(ERRORS.TOO_LARGE);
      return;
    }
    if (insecure && !insecureOk && !force) return; // waits for "Upload anyway"
    setBusy(true);
    setError(null);
    try {
      const p = await previewImport(f, pw || undefined);
      setPassword(''); // used once, never kept
      onPreview(p);
    } catch (e) {
      const code = e instanceof ApiError ? (e.code as ImportErrorCode | undefined) : undefined;
      if (code === 'PASSWORD_REQUIRED' || code === 'BAD_PASSWORD') {
        setNeedPassword(code === 'BAD_PASSWORD' && pw ? 'bad' : 'required');
        setPassword('');
      } else if (code && code in ERRORS) setError(ERRORS[code as keyof typeof ERRORS]);
      else if (e instanceof ApiError && e.status === 413) setError(ERRORS.TOO_LARGE);
      else setError({ title: "Couldn't read the statement", body: errorMessage(e) || 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    setNeedPassword(null);
    setPassword('');
    setError(null);
    if (!/\.(pdf|csv|xlsx|xls)$/i.test(f.name)) {
      setError(ERRORS.UNSUPPORTED);
      return;
    }
    void send(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const unlock = (e: FormEvent) => {
    e.preventDefault();
    if (file && password) void send(file, password);
  };

  return (
    <Card className="flex flex-col gap-4">
      {insecure && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">You're not on a secure (https) connection — your statement would cross the network unencrypted.</p>
            <p className="mt-0.5 opacity-90">Open Hearth through its https address if you can.</p>
            {!insecureOk && (
              <Button
                size="sm"
                variant="danger"
                className="mt-2"
                onClick={() => {
                  setInsecureOk(true);
                  if (file && !error && !needPassword) void send(file, undefined, true);
                }}
              >
                {file ? 'Upload anyway' : 'Allow upload anyway'}
              </Button>
            )}
            {insecureOk && <p className="mt-1 text-xs font-semibold">Upload allowed for this visit.</p>}
          </div>
        </div>
      )}

      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition focus-within:ring-4 focus-within:ring-ring',
          drag ? 'border-primary bg-primary-soft/50' : 'border-border-strong hover:border-primary hover:bg-surface-2',
          busy && 'pointer-events-none opacity-70',
        )}
      >
        <span className="flex size-14 items-center justify-center rounded-2xl" style={{ backgroundColor: `color-mix(in oklab, ${mod.accent} 14%, transparent)`, color: mod.accent }}>
          <Upload size={26} aria-hidden />
        </span>
        <span className="text-base font-semibold text-fg">{busy ? 'Reading your statement…' : file ? file.name : 'Drop a bank statement here'}</span>
        <span className="text-sm text-muted">PDF, CSV or Excel (.xlsx) from DBS/POSB or UOB · up to 10 MB</span>
        <span className={buttonClass('secondary', 'sm')}>{file ? 'Choose another file' : 'Choose a file'}</span>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label="Bank statement file"
          disabled={busy}
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      <p className="flex items-center gap-2 text-xs text-muted">
        <Lock size={13} className="shrink-0" aria-hidden />
        The file is read on your Hearth server and never stored — only the transactions you choose are saved.
      </p>
      <div className="rounded-2xl bg-surface-2/70 px-4 py-3 text-[13px] text-muted">
        <p className="font-semibold text-fg">Where to get a statement</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li><b className="font-medium text-fg">DBS / POSB digibank:</b> Accounts → Transaction History → Download CSV (or save the monthly e-statement PDF)</li>
          <li><b className="font-medium text-fg">UOB Personal Internet Banking:</b> Account → Transaction History → Export, choose CSV</li>
        </ul>
        <p className="mt-1 text-xs">Excel works as .xlsx; the old .xls format isn't supported — export CSV instead.</p>
      </div>

      {needPassword && file && (
        <form onSubmit={unlock} className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-2/60 p-4">
          <p className="flex items-start gap-2 text-[13px] text-muted">
            <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
            Some bank PDFs are protected — often with your NRIC or date of birth. It's used once and never saved.
          </p>
          <Field
            label="Statement password"
            error={needPassword === 'bad' ? "That password didn't open the file. Try again." : undefined}
          >
            <Input
              ref={pwInput}
              type="password"
              name="statement-password"
              autoComplete="off"
              icon={KeyRound}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              invalid={needPassword === 'bad'}
            />
          </Field>
          <Button type="submit" className="self-start" loading={busy} disabled={!password || (insecure && !insecureOk)}>Unlock and read</Button>
        </form>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning-soft-fg">
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">{error.title}</p>
            <p className="mt-0.5 opacity-90">{error.body}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---- step 2: review ---------------------------------------------------------------------------

function ReviewStep({
  preview, choices, setChoices, onBack, onNext,
}: {
  preview: ImportPreview; choices: Record<string, Choice>; setChoices: React.Dispatch<React.SetStateAction<Record<string, Choice>>>;
  onBack: () => void; onNext: () => void;
}) {
  const { fmt } = useMoney();
  const { data: categories = [] } = useCategories();
  const [filter, setFilter] = useState<Filter>('all');
  // Rows the "Uncategorized" filter matched when it was picked: categorizing one keeps it on screen.
  const [uncatIds, setUncatIds] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [suggest, setSuggest] = useState<{ row_id: string; key: string; category_id: number | null; count: number } | null>(null);
  const rows = preview.rows;
  // Same-merchant rows (server's normalised `merchant`) for "set for all from this merchant".
  const keyOf = useMemo(() => new Map(rows.map((r) => [r.row_id, r.merchant.trim().toLowerCase()])), [rows]);

  const counts = useMemo(() => ({
    all: rows.length,
    uncat: rows.filter((r) => choices[r.row_id]?.category_id == null && !choices[r.row_id]?.transfer).length,
    dup: rows.filter((r) => r.duplicate).length,
    income: rows.filter((r) => r.kind === 'income').length,
  }), [rows, choices]);
  const included = rows.filter((r) => choices[r.row_id]?.include);
  const sel = { count: included.length, income: 0, spending: 0 };
  for (const r of included) if (!choices[r.row_id].transfer) r.kind === 'income' ? (sel.income += r.amount) : (sel.spending += r.amount);

  const visible = useMemo(() => rows.filter((r) => {
    if (filter === 'uncat') return uncatIds.has(r.row_id);
    if (filter === 'dup') return r.duplicate;
    if (filter === 'income') return r.kind === 'income';
    return true;
  }), [rows, uncatIds, filter]);
  const page = visible.slice(0, shown);
  const groups = useMemo(() => {
    const m = new Map<string, PreviewRow[]>();
    for (const r of page) m.set(r.date, [...(m.get(r.date) ?? []), r]);
    return [...m.entries()];
  }, [page]);

  const setCategory = (r: PreviewRow, category_id: number | null) => {
    setChoices((c) => ({ ...c, [r.row_id]: { ...c[r.row_id], category_id } }));
    const key = keyOf.get(r.row_id)!;
    const count = key ? rows.filter((x) => x.row_id !== r.row_id && x.kind === r.kind && keyOf.get(x.row_id) === key && choices[x.row_id]?.category_id !== category_id).length : 0;
    setSuggest(count ? { row_id: r.row_id, key, category_id, count } : null);
  };
  const applyAll = () => {
    if (!suggest) return;
    const r = rows.find((x) => x.row_id === suggest.row_id)!;
    setChoices((c) => {
      const n = { ...c };
      for (const x of rows) if (x.kind === r.kind && keyOf.get(x.row_id) === suggest.key) n[x.row_id] = { ...n[x.row_id], category_id: suggest.category_id };
      return n;
    });
    toast.success(`Updated ${plural(suggest.count + 1, 'transaction')}`);
    setSuggest(null);
  };
  const toggle = (r: PreviewRow, include: boolean) => setChoices((c) => ({ ...c, [r.row_id]: { ...c[r.row_id], include } }));
  const setTransfer = (r: PreviewRow, transfer: boolean) => setChoices((c) => ({ ...c, [r.row_id]: { ...c[r.row_id], transfer } }));
  const setPair = (r: PreviewRow, pair: boolean) => setChoices((c) => ({ ...c, [r.row_id]: { ...c[r.row_id], pair } }));
  /** Bulk include/exclude. "Select all" leaves duplicates alone unless the Duplicates filter is on. */
  const bulk = (on: boolean, which: (r: PreviewRow) => boolean) => setChoices((c) => {
    const n = { ...c };
    for (const r of rows) if (which(r)) n[r.row_id] = { ...n[r.row_id], include: on };
    return n;
  });
  const inView = (r: PreviewRow) => visible.includes(r) && (filter === 'dup' || !r.duplicate);

  const catsByKind = useMemo(() => ({
    expense: categories.filter((c) => c.kind === 'expense'),
    income: categories.filter((c) => c.kind === 'income'),
  }), [categories]);
  const suggestCat = suggest ? categories.find((c) => c.id === suggest.category_id)?.name ?? 'Uncategorized' : '';

  return (
    <div className="flex flex-col gap-4">
      <StatementHeader preview={preview} />

      <div className="-mx-1 overflow-x-auto px-1 pb-0.5 scrollbar-none">
        <SegmentedControl<Filter>
          size="sm"
          aria-label="Show"
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setShown(PAGE);
            if (f === 'uncat') setUncatIds(new Set(rows.filter((r) => choices[r.row_id]?.category_id == null && !choices[r.row_id]?.transfer).map((r) => r.row_id)));
          }}
          options={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'uncat', label: `Uncategorized ${counts.uncat}` },
            { value: 'dup', label: `Duplicates ${counts.dup}` },
            { value: 'income', label: `Income ${counts.income}` },
          ]}
        />
      </div>

      <div className="-mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Select transactions">
        <Button size="sm" variant="ghost" onClick={() => bulk(true, inView)}>Select all{filter !== 'all' ? ' shown' : ''}</Button>
        <Button size="sm" variant="ghost" onClick={() => bulk(false, (r) => visible.includes(r))}>Deselect all{filter !== 'all' ? ' shown' : ''}</Button>
        {counts.income > 0 && <Button size="sm" variant="ghost" onClick={() => bulk(false, (r) => r.kind === 'income')}>Untick all income</Button>}
      </div>

      {!page.length ? (
        <Card><p className="py-8 text-center text-sm text-muted">{filter === 'uncat' ? 'Everything has a category. 🎉' : 'Nothing here.'}</p></Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([date, items]) => (
            <section key={date} aria-label={fmtDay(date)}>
              <h3 className="mb-1.5 px-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">{fmtDay(date)}</h3>
              <Card padding="none" className="divide-y divide-border/70">
                {items.map((r) => (
                  <div key={r.row_id}>
                    <ReviewRow
                      r={r}
                      choice={choices[r.row_id]}
                      categories={catsByKind[r.kind]}
                      fmt={fmt}
                      onCategory={setCategory}
                      onToggle={toggle}
                      onTransfer={setTransfer}
                      onPair={setPair}
                    />
                    {suggest?.row_id === r.row_id && (
                      <div className="flex flex-wrap items-center gap-2 bg-primary-soft/50 px-4 py-2 text-[13px] text-primary-soft-fg" role="status">
                        <Wand2 size={14} aria-hidden />
                        <span className="min-w-0 flex-1">Use <b>{suggestCat}</b> for {plural(suggest.count, 'other transaction')} from this merchant?</span>
                        <Button size="sm" variant="soft" onClick={applyAll}>Set for all</Button>
                        <Button size="sm" variant="ghost" onClick={() => setSuggest(null)}>No thanks</Button>
                      </div>
                    )}
                  </div>
                ))}
              </Card>
            </section>
          ))}
          {visible.length > shown && (
            <Button variant="secondary" className="self-center" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more of {visible.length - shown}
            </Button>
          )}
        </div>
      )}

      <StickyBar>
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="font-semibold text-fg">{sel.count} of {plural(rows.length, 'transaction')} selected</div>
          <div className="truncate text-muted tabular"><span className="text-success-soft-fg">+{fmt(sel.income)}</span> · −{fmt(sel.spending)}</div>
        </div>
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack} aria-label="Start over"><span className="hidden sm:inline">Start over</span></Button>
        <Button iconRight={ArrowRight} onClick={onNext} disabled={!sel.count}>Continue</Button>
      </StickyBar>
    </div>
  );
}

const ReviewRow = memo(function ReviewRow({
  r, choice, categories, fmt, onCategory, onToggle, onTransfer, onPair,
}: {
  r: PreviewRow; choice: Choice; categories: Category[]; fmt: (n: number) => string;
  onCategory: (r: PreviewRow, id: number | null) => void; onToggle: (r: PreviewRow, on: boolean) => void;
  onTransfer: (r: PreviewRow, on: boolean) => void; onPair: (r: PreviewRow, on: boolean) => void;
}) {
  // The paired row moves the other way: money out here is money in there.
  const pairText = r.pair && `${r.pair.account_label} ${r.kind === 'expense' ? '+' : '−'}${fmt(Math.abs(r.pair.amount))} on ${fmtDate(r.pair.date, 'd MMM')}`;
  const menu = (
    <Menu
      label={`More for ${r.description}`}
      items={[
        { label: choice.transfer ? 'Not a transfer' : 'Mark as transfer', icon: ArrowLeftRight, onSelect: () => onTransfer(r, !choice.transfer) },
        { label: choice.include ? 'Leave out of this import' : 'Include in this import', icon: choice.include ? X : Check, onSelect: () => onToggle(r, !choice.include) },
      ]}
    />
  );
  const uncat = choice.category_id == null && !choice.transfer;
  const auto = choice.category_id === r.category_id && r.category_source !== 'none' && !uncat;
  return (
    <div
      className={cn(
        'flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4',
        !choice.include && 'opacity-55',
        choice.include && uncat && 'bg-warning-soft/40',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Checkbox checked={choice.include} onChange={(on) => onToggle(r, on)} aria-label={`Import ${r.description}`} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-words text-[15px] font-semibold text-fg">{r.description}</span>
            <Amount kind={r.kind} value={r.amount} fmt={fmt} className={cn('text-[15px] sm:hidden', choice.transfer && 'text-muted')} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {r.duplicate && <Badge tone="neutral">Already in Hearth · skipped</Badge>}
            {r.recurring_group && <span className="inline-flex items-center gap-1"><Repeat size={11} aria-hidden />Repeats monthly</span>}
            {r.balance != null && <span className="tabular">Balance {fmt(r.balance)}</span>}
            {/* Only transfers get a visible chip (it turns the flag off); marking one lives in the row's ⋯ menu. */}
            {choice.transfer && (
              <button
                type="button"
                aria-pressed
                aria-label="Transfer between my accounts — tap to undo"
                onClick={() => onTransfer(r, false)}
                className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary-soft-fg transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
              >
                <ArrowLeftRight size={11} aria-hidden />Transfer between my accounts<X size={11} aria-hidden />
              </button>
            )}
          </div>
          {choice.transfer && pairText && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span>
                {choice.pair ? <>Also marks <b className="font-semibold text-fg">{pairText}</b> as a transfer</> : <>Only this row is marked — {pairText} stays as it is</>}
              </span>
              <button type="button" onClick={() => onPair(r, !choice.pair)} className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring rounded">
                {choice.pair ? "Don't mark that one" : 'Mark it too'}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 pl-8 sm:pl-0">
        {choice.transfer ? (
          <span className="min-w-0 flex-1 text-[13px] text-muted sm:w-[calc(12rem+6.5rem+0.5rem)] sm:flex-none">Not counted as income or spending</span>
        ) : (<>
        <div className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
          <Select
            size="sm"
            aria-label={`Category for ${r.description}`}
            value={choice.category_id == null ? '' : String(choice.category_id)}
            onChange={(e) => onCategory(r, e.target.value ? Number(e.target.value) : null)}
            className={cn(uncat && choice.include && '[&_select]:border-warning')}
            options={[{ value: '', label: 'Uncategorized' }, ...categories.map((c) => ({ value: String(c.id), label: c.name }))]}
          />
        </div>
        {auto ? (
          <span
            className="inline-flex w-[6.5rem] shrink-0 items-center gap-1 text-[11px] font-medium leading-tight text-subtle"
            title={r.category_source === 'learned' ? 'Hearth remembered how you categorized this merchant before' : 'Suggested by Hearth from the merchant name'}
          >
            <Sparkles size={11} className="shrink-0" aria-hidden />{r.category_source === 'learned' ? 'Learned from you' : 'Suggested'}
          </span>
        ) : (
          <span className="w-[6.5rem] shrink-0 text-[11px] font-medium text-warning-soft-fg">{uncat && choice.include ? 'Pick one' : ''}</span>
        )}
        </>)}
        <Amount kind={r.kind} value={r.amount} fmt={fmt} className={cn('hidden w-28 text-right text-[15px] sm:inline', choice.transfer && 'text-muted')} />
        {menu}
      </div>
    </div>
  );
});

function StatementHeader({ preview: p }: { preview: ImportPreview }) {
  const { fmt, currency } = useMoney();
  // ponytail: no conversion — amounts are imported as numbers in the family's currency.
  const warnings = currency !== p.currency
    ? [`This statement is in ${p.currency} but your family budget uses ${currency}. Amounts are imported as they are, without conversion.`, ...p.warnings]
    : p.warnings;
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-info-soft text-info-soft-fg"><Landmark size={22} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold text-fg">{p.account?.label ?? BANK_LABEL[p.bank]}</div>
          <div className="text-sm text-muted">{fmtDate(p.period.from, 'd MMM yyyy')} – {fmtDate(p.period.to, 'd MMM yyyy')} · {p.format.toUpperCase()}</div>
        </div>
        <Badge tone="info" size="md">{p.currency}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Fact label="Opening balance" value={p.opening_balance == null ? '—' : fmt(p.opening_balance)} />
        <Fact label="Closing balance" value={p.closing_balance == null ? '—' : fmt(p.closing_balance)} />
        <Fact label="Money in" value={<span className="text-success-soft-fg">+{fmt(p.summary.income)}</span>} />
        <Fact label="Money out" value={`−${fmt(p.summary.spending)}`} />
      </dl>
      <p className="text-[13px] text-muted">
        {plural(p.summary.count, 'transaction')}
        {p.summary.duplicates > 0 && ` · ${p.summary.duplicates} already in Hearth (unticked)`}
      </p>
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-soft-fg">
              <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />{w}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2/70 px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate font-semibold text-fg tabular">{value}</dd>
    </div>
  );
}

/** Action bar that sticks to the bottom while the long review list scrolls. */
function StickyBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-surface/95 px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:pb-3 sm:shadow-lift lg:bottom-4">
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

// ---- step 3: recurring ------------------------------------------------------------------------

function RecurringStep({
  preview, bills, setBills, onBack, onNext,
}: {
  preview: ImportPreview; bills: Record<string, BillDraft>; setBills: React.Dispatch<React.SetStateAction<Record<string, BillDraft>>>;
  onBack: () => void; onNext: () => void;
}) {
  const { fmt, currency } = useMoney();
  const { data: categories = [] } = useCategories();
  const set = (g: string, patch: Partial<BillDraft>) => setBills((b) => ({ ...b, [g]: { ...b[g], ...patch } }));
  const on = preview.recurring.filter((b) => bills[b.group]?.on).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-sm text-muted">
        These payments showed up every month. Turn one on to add it to <Link to="/budget/bills" className="font-semibold text-primary">Bills</Link> so Hearth reminds you before it's due.
      </p>
      {preview.recurring.map((b) => {
        const d = bills[b.group];
        const invalidAmount = d.on && parseAmount(d.amount) === null;
        const dayN = Number(d.day);
        const invalidDay = d.on && !(Number.isInteger(dayN) && dayN >= 1 && dayN <= 31);
        return (
          <Card key={b.group} className={cn('flex flex-col gap-3', !d.on && 'opacity-80')}>
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info-soft text-info-soft-fg"><CalendarClock size={19} aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-fg">{b.merchant ? merchantCase(b.merchant) : b.description}</div>
                <div className="text-[13px] text-muted">
                  {fmt(b.amount)} around the {ordinal(b.day_of_month)} · seen in {plural(b.months_seen, 'month')}
                </div>
                {b.existing_bill_id && <Badge tone="success" className="mt-1">Already one of your bills</Badge>}
              </div>
              <Switch checked={d.on} onChange={(v) => set(b.group, { on: v })} aria-label={`Create a monthly bill for ${b.merchant ? merchantCase(b.merchant) : b.description}`} />
            </div>
            {d.on && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_7rem_1.4fr]">
                <Field label="Amount" error={invalidAmount ? 'Enter an amount' : undefined}>
                  <MoneyInput size="md" value={d.amount} onChange={(v) => set(b.group, { amount: v })} currency={currency} invalid={invalidAmount} />
                </Field>
                <Field label="Day of month" error={invalidDay ? '1–31' : undefined}>
                  <Input type="number" inputMode="numeric" min={1} max={31} value={d.day} invalid={invalidDay} onChange={(e) => set(b.group, { day: e.target.value })} />
                </Field>
                <Field label="Category" className="col-span-2 sm:col-span-1">
                  <Select
                    value={d.category_id == null ? '' : String(d.category_id)}
                    onChange={(e) => set(b.group, { category_id: e.target.value ? Number(e.target.value) : null })}
                    options={[{ value: '', label: 'Uncategorized' }, ...categories.filter((c) => c.kind === b.kind).map((c) => ({ value: String(c.id), label: c.name }))]}
                  />
                </Field>
              </div>
            )}
          </Card>
        );
      })}
      <StickyBar>
        <div className="min-w-0 flex-1 text-[13px] font-semibold text-fg">{on ? `${plural(on, 'bill')} to create` : 'No bills will be created'}</div>
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Back</Button>
        <Button
          iconRight={ArrowRight}
          onClick={onNext}
          disabled={preview.recurring.some((b) => {
            const d = bills[b.group];
            const n = Number(d.day);
            return d.on && (parseAmount(d.amount) === null || !(Number.isInteger(n) && n >= 1 && n <= 31));
          })}
        >
          Continue
        </Button>
      </StickyBar>
    </div>
  );
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function ImportSummary({ preview, choices, bills }: { preview: ImportPreview; choices: Record<string, Choice>; bills: number }) {
  const n = preview.rows.filter((r) => choices[r.row_id]?.include).length;
  const uncat = preview.rows.filter((r) => choices[r.row_id]?.include && choices[r.row_id]?.category_id == null && !choices[r.row_id]?.transfer).length;
  return (
    <ul className="flex flex-col gap-1 rounded-2xl bg-surface-2/70 px-4 py-3 text-sm text-fg">
      <li><b>{plural(n, 'transaction')}</b> from {preview.account?.label ?? BANK_LABEL[preview.bank]}</li>
      {preview.rows.some((r) => choices[r.row_id]?.include && choices[r.row_id]?.transfer) && <li className="text-muted">{preview.rows.filter((r) => choices[r.row_id]?.include && choices[r.row_id]?.transfer).length} marked as transfers between your accounts — not counted as income or spending</li>}
      {uncat > 0 && <li className="text-muted">{uncat} without a category — you can sort them later</li>}
      {bills > 0 && <li>{plural(bills, 'monthly bill')} to create</li>}
    </ul>
  );
}

// ---- done -------------------------------------------------------------------------------------

function DoneStep({ result, onAgain }: { result: CommitResult; onAgain: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={Check}
        accent="#30A46C"
        title={`Imported ${plural(result.created, 'transaction')}`}
        description={
          <span role="status">
            {[
              result.skipped_duplicates ? `${result.skipped_duplicates} duplicate${result.skipped_duplicates === 1 ? '' : 's'} skipped` : null,
              result.excluded ? `${result.excluded} left out` : null,
              result.bills_created ? `${plural(result.bills_created, 'monthly bill')} created` : null,
              `visible to ${result.import.visibility === 'private' ? 'only you' : 'adults only'}`,
            ].filter(Boolean).join(' · ')}
          </span>
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link to={`/budget/transactions?import=${result.import.id}`} className={buttonClass('primary', 'md')}>See transactions</Link>
            <Link to="/budget/insights" className={buttonClass('secondary', 'md')}>View insights</Link>
            <Button variant="ghost" icon={Upload} onClick={onAgain}>Import another</Button>
          </div>
        }
      />
    </Card>
  );
}

// ---- history ----------------------------------------------------------------------------------

function ImportHistory() {
  const { data, isLoading, isError, refetch } = useImports();
  return (
    <Card>
      <CardHeader title="Past imports" subtitle="Undo removes that statement's transactions" icon={History} accent={mod.accent} />
      {isLoading ? (
        <SkeletonList rows={2} />
      ) : isError ? (
        <div className="py-4 text-center text-sm text-muted">Couldn't load past imports. <button type="button" className="font-semibold text-primary" onClick={() => refetch()}>Retry</button></div>
      ) : !data?.length ? (
        <p className="py-6 text-center text-sm text-muted">No statements imported yet.</p>
      ) : (
        <ul className="-my-1 divide-y divide-border">{data.map((i) => <HistoryRow key={i.id} i={i} />)}</ul>
      )}
    </Card>
  );
}

function HistoryRow({ i }: { i: ImportOut }) {
  const { fmt } = useMoney();
  const confirm = useConfirm();
  const invalidate = useInvalidateAfterImport();
  const by = useMember(i.created_by);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    const ok = await confirm({
      title: `Undo the ${importLabel(i)} import?`,
      message: `This removes the ${plural(i.row_count, 'transaction')} it added (${fmtDate(i.period_from, 'd MMM')} – ${fmtDate(i.period_to, 'd MMM yyyy')}). Bills it created stay.`,
      confirmLabel: 'Undo import',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.del<{ ok: boolean; removed: number }>(`/budget/imports/${i.id}`);
      toast.success(`Removed ${plural(res.removed, 'transaction')}`);
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info-soft text-info-soft-fg"><Landmark size={18} aria-hidden /></span>
      <div className="min-w-[14rem] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/budget/transactions?import=${i.id}`} className="text-[15px] font-semibold text-fg hover:text-primary hover:underline">{importLabel(i)}</Link>
          <VisibilityBadge value={i.visibility} />
        </div>
        <div className="text-[13px] text-muted">
          {fmtDate(i.period_from, 'd MMM')} – {fmtDate(i.period_to, 'd MMM yyyy')} · {plural(i.row_count, 'transaction')}
        </div>
        <div className="text-xs text-subtle tabular">
          <span className="whitespace-nowrap text-success-soft-fg">+{fmt(i.total_income)}</span> · <span className="whitespace-nowrap">−{fmt(i.total_spending)}</span> · {by ? `${firstName(by.name)}, ` : ''}{fmtRelative(i.created_at)}
        </div>
      </div>
      <Button size="sm" variant="ghost" icon={Undo2} loading={busy} onClick={undo} className="ml-auto text-danger hover:bg-danger-soft hover:text-danger">Undo import</Button>
    </li>
  );
}
