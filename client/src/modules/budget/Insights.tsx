// Insights tab (adults): averages over 3/6/12 months, income vs spending, categories vs average,
// top merchants, spikes, recurring total and whether the savings goals fit the monthly surplus.
import { Link, useSearchParams } from 'react-router';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, CalendarClock, ChartColumn, Flame, Landmark, Lightbulb, PiggyBank, Plus, Scale, Store, Upload,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { fmtDate, plural } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, SegmentedControl, Skeleton, SkeletonCard, buttonClass } from '../../ui';
import { currentMonth, useInsights, useMoney, type Insights as InsightsData } from './api';
import { TrendChart } from './Charts';
import { useBudget } from './context';
import { CategoryIcon, Progress, Stat } from './shared';
import mod from './index';

const WINDOWS = [3, 6, 12] as const;

/** "+12%" / "−8%"; spending going up is the warning direction. */
function Change({ pct }: { pct: number | null }) {
  if (pct === null || !Number.isFinite(pct)) return <span className="text-xs text-subtle">new</span>;
  const r = Math.round(pct);
  if (r === 0) return <span className="text-xs text-muted tabular">±0%</span>;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-semibold tabular', r > 0 ? 'text-danger' : 'text-success-soft-fg')}>
      {r > 0 ? <ArrowUpRight size={12} aria-hidden /> : <ArrowDownLeft size={12} aria-hidden />}
      {r > 0 ? '+' : '−'}{Math.abs(r)}%
      <span className="sr-only"> vs average</span>
    </span>
  );
}

function GoalsCard({ g, fmt }: { g: InsightsData['goals']; fmt: (n: number) => string }) {
  const status = g.status === 'on_track'
    ? { tone: 'success' as const, text: 'On track' }
    : g.status === 'short'
      ? { tone: 'warning' as const, text: `Short by ${fmt(g.shortfall)}/mo` }
      : { tone: 'neutral' as const, text: 'Not enough data yet' };
  const noGoals = !g.items.length && !g.undated;
  return (
    <Card className="border-success/30">
      <CardHeader
        title="Can we afford our goals?"
        subtitle={g.status === 'no_data' ? 'Import a statement or add a few months of transactions' : 'Monthly savings needed vs your average surplus'}
        icon={PiggyBank}
        accent="#30A46C"
        action={<Link to="/budget/goals" className={buttonClass('ghost', 'sm')}>Goals <ArrowRight size={14} /></Link>}
      />
      {noGoals ? (
        <p className="py-4 text-center text-sm text-muted">No savings goals yet. <Link to="/budget/goals" className="font-semibold text-primary">Start one</Link> and Hearth will check it fits your budget.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex gap-6">
              <div>
                <div className="text-xs font-medium text-muted">Needed each month</div>
                <div className="text-2xl font-bold tracking-tight text-fg tabular">{fmt(g.needed_monthly)}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted">Average surplus</div>
                <div className={cn('text-2xl font-bold tracking-tight tabular', g.surplus < 0 ? 'text-danger' : 'text-fg')}>{fmt(g.surplus)}</div>
              </div>
            </div>
            <Badge tone={status.tone} size="md">{status.text}</Badge>
          </div>
          {g.status !== 'no_data' && g.needed_monthly > 0 && (
            <div>
              <Progress
                value={Math.max(g.surplus, 0)}
                max={g.needed_monthly}
                color={g.status === 'short' ? 'var(--warning)' : '#30A46C'}
                warnAt={2}
                label="How much of what the goals need your surplus covers"
              />
              <p className="mt-1 text-xs text-muted">
                Your surplus covers {Math.min(100, Math.round((Math.max(g.surplus, 0) / g.needed_monthly) * 100))}% of what your dated goals need each month.
              </p>
            </div>
          )}
          {g.items.length > 0 && (
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {g.items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <span className="text-lg" aria-hidden>{it.emoji || '🎯'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-fg">{it.name}</div>
                    <div className="text-xs text-muted">
                      {it.target_date ? `by ${fmtDate(it.target_date, 'MMM yyyy')}` : 'No target date'}
                      {it.auto_monthly && ' · saves automatically'}
                    </div>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-fg tabular">{fmt(it.monthly)}<span className="font-normal text-muted">/mo</span></span>
                </li>
              ))}
            </ul>
          )}
          {g.undated > 0 && <p className="text-xs text-muted">{plural(g.undated, 'goal has', 'goals have')} no target date, so {g.undated === 1 ? "it isn't" : "they aren't"} counted. Add a date to plan monthly savings.</p>}
          {g.suggestions.length > 0 && (
            <ul className="flex flex-col gap-2">
              {g.suggestions.map((s, i) => (
                <li key={i} className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm text-fg">
                  <Lightbulb size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Insights() {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('months'));
  const months = (WINDOWS as readonly number[]).includes(raw) ? raw : 3;
  const setMonths = (n: number) => setParams((p) => { const q = new URLSearchParams(p); if (n === 3) q.delete('months'); else q.set('months', String(n)); return q; }, { replace: true });
  const { fmt } = useMoney();
  const { addTransaction } = useBudget();
  const { data, isLoading, isError, refetch, isFetching } = useInsights(months);

  const picker = (
    <SegmentedControl
      size="sm"
      aria-label="Average over"
      value={String(months)}
      onChange={(v) => setMonths(Number(v))}
      options={WINDOWS.map((n) => ({ value: String(n), label: `${n} months` }))}
    />
  );

  if (isLoading || !data) {
    if (isError) {
      return (
        <Card>
          <EmptyState icon={ChartColumn} accent={mod.accent} title="Couldn't load insights" description="Check your connection and try again." action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />
        </Card>
      );
    }
    return (
      <div className="flex flex-col gap-5" role="status" aria-label="Loading insights">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 [&>*]:min-w-0">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)}</div>
        <SkeletonCard className="h-72" />
      </div>
    );
  }

  const empty = data.months.every((m) => !m.income && !m.spending);
  if (empty) {
    return (
      <Card>
        <EmptyState
          icon={ChartColumn}
          accent={mod.accent}
          title="No insights yet"
          description="Import a statement or add transactions to see insights — averages, trends, top merchants and whether your goals fit."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link to="/budget/import" className={buttonClass('primary', 'md')}><Upload size={16} aria-hidden /> Import statement</Link>
              <Button variant="secondary" icon={Plus} onClick={() => addTransaction()}>Add a transaction</Button>
            </div>
          }
        />
      </Card>
    );
  }

  const now = currentMonth();
  const partial = data.months.find((m) => m.partial)?.month ?? (data.months.some((m) => m.month === now) ? now : undefined);
  const trend = data.months.map((m) => ({ month: m.month, income: m.income, spent: m.spending }));
  const [firstBalance, ...moreBalances] = data.balances;
  const maxMerchant = Math.max(1, ...data.merchants.map((m) => m.total));

  return (
    <div className={cn('flex flex-col gap-5 transition-opacity', isFetching && 'opacity-80')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Monthly averages over the last {months} full months</p>
        {picker}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 [&>*]:min-w-0">
        <Stat label="Avg income" icon={<ArrowDownLeft size={14} />} tone="#12A594" value={fmt(data.avg_income)} hint="per month" />
        <Stat label="Avg spending" icon={<ArrowUpRight size={14} />} tone="#5B5BD6" value={fmt(data.avg_spending)} hint="per month" />
        <Stat
          label="Avg surplus"
          icon={<Scale size={14} />}
          tone={data.avg_surplus >= 0 ? '#30A46C' : '#E5484D'}
          value={<span className={data.avg_surplus < 0 ? 'text-danger' : undefined}>{fmt(data.avg_surplus, { sign: true })}</span>}
          hint={data.avg_surplus >= 0 ? 'left over each month' : 'more out than in'}
        />
        <Stat
          label="Latest balance"
          icon={<Landmark size={14} />}
          tone="#0090FF"
          value={firstBalance ? fmt(firstBalance.balance) : '—'}
          hint={firstBalance ? `${firstBalance.account_label} · ${fmtDate(firstBalance.as_of, 'MMM d')}${moreBalances.length ? ` · +${moreBalances.length} more` : ''}` : 'Import a statement to see it'}
        />
      </div>

      {moreBalances.length > 0 && (
        <Card padding="sm">
          <h2 className="sr-only">All account balances</h2>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 px-1 text-sm">
            {data.balances.map((b) => (
              <li key={b.account_label} className="flex items-center gap-2">
                <Landmark size={14} className="text-subtle" aria-hidden />
                <span className="text-muted">{b.account_label}</span>
                <span className="font-semibold text-fg tabular">{fmt(b.balance)}</span>
                <span className="text-xs text-subtle">{fmtDate(b.as_of, 'MMM d')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.spikes.length > 0 && (
        <div className="flex flex-col gap-2">
          {data.spikes.map((s) => (
            <div key={`${s.category_id}-${s.name}`} className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning-soft-fg">
              <Flame size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold">{s.name}</span> is at {fmt(s.this_month)} this month — {Math.round(s.change_pct)}% above your {fmt(s.avg)} average.
              </span>
            </div>
          ))}
        </div>
      )}

      <GoalsCard g={data.goals} fmt={fmt} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.25fr_1fr] [&>*]:min-w-0">
        <Card>
          <CardHeader title="Income vs spending" subtitle={`Last ${months} months + this month so far`} icon={Scale} accent={mod.accent} />
          <TrendChart trend={trend} month="" partialMonth={partial} fmt={fmt} />
        </Card>
        <Card>
          <CardHeader
            title="Recurring"
            subtitle={`${fmt(data.recurring.total_monthly)} a month in bills`}
            icon={CalendarClock}
            accent="#0090FF"
            action={<Link to="/budget/bills" className={buttonClass('ghost', 'sm')}>Bills <ArrowRight size={14} /></Link>}
          />
          {data.recurring.bills.length ? (
            <ul className="-my-1 divide-y divide-border">
              {data.recurring.bills.slice(0, 8).map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate text-fg">{b.description}</span>
                  <span className="shrink-0 font-semibold text-fg tabular">{fmt(b.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No monthly bills yet.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Categories" subtitle="This month vs your monthly average" icon={ChartColumn} accent="#F76B15" />
          {data.categories.length ? (
            <ul className="flex flex-col gap-1">
              {data.categories.map((c) => (
                <li key={`${c.category_id}-${c.name}`} className="flex items-center gap-3 rounded-xl px-1 py-1.5">
                  <CategoryIcon category={c} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg">{c.name}</div>
                    <div className="text-xs text-muted tabular">avg {fmt(c.avg)}/mo</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold text-fg tabular">{fmt(c.this_month)}</div>
                    <Change pct={c.change_pct} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No categorised spending yet.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Top merchants" subtitle={`Over the last ${months} months`} icon={Store} accent="#8E4EC6" />
          {data.merchants.length ? (
            <ol className="flex flex-col gap-3">
              {data.merchants.map((m) => (
                <li key={m.merchant}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-fg">{m.merchant}</span>
                    <span className="shrink-0 tabular"><span className="font-semibold text-fg">{fmt(m.total)}</span> <span className="text-xs text-muted">· {plural(m.count, 'payment')}</span></span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2 dark:bg-surface-3"><div className="h-full rounded-full bg-[#8E4EC6]" style={{ width: `${(m.total / maxMerchant) * 100}%` }} /></div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-sm text-muted">Nothing to show yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
