// Monthly overview: stat tiles, spending donut, budget limits, 6-month trend, bills, goals, recent activity.
import { Link, useNavigate } from 'react-router';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, CalendarClock, ChartPie, CircleAlert, Gauge, PiggyBank, Plus, Receipt, Scale, SlidersHorizontal,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { Avatar, Button, Card, CardHeader, EmptyState, Skeleton, SkeletonCard, SkeletonList, buttonClass } from '../../ui';
import { useAuth } from '../../lib/auth';
import { firstName } from '../../lib/format';
import { addMonths, currentMonth, daysInMonth, monthLabel, useBills, useCanManage, useGoals, useMoney, useMonthParam, useRecentTransactions, useSummary } from './api';
import { BillRow } from './Bills';
import { SpendingDonut, TrendChart, spendingSlices } from './Charts';
import { useBudget } from './context';
import { GoalCard } from './Goals';
import { CategoryIcon, Progress, Stat } from './shared';
import { TransactionRow } from './TransactionDetail';
import mod from './index';

export default function Overview() {
  const [month, setMonth] = useMonthParam();
  const navigate = useNavigate();
  const { fmt } = useMoney();
  const { members } = useAuth();
  const canManage = useCanManage();
  const { addTransaction, openTransaction, openCategories } = useBudget();
  const { data: s, isLoading, isError, refetch } = useSummary(month);
  const { data: recent } = useRecentTransactions(month);
  const { data: bills } = useBills(month);
  const { data: goals } = useGoals();
  const link = (path: string) => `/budget${path}${month !== currentMonth() ? `?month=${month}` : ''}`;

  if (isLoading || !s) {
    if (isError) {
      return (
        <Card>
          <EmptyState icon={ChartPie} accent={mod.accent} title="Couldn't load your budget" description="Check your connection and try again." action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />
        </Card>
      );
    }
    return (
      <div className="flex flex-col gap-5" role="status" aria-label="Loading budget">
        <div className="grid [&>*]:min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)}</div>
        <div className="grid [&>*]:min-w-0 grid-cols-1 gap-5 lg:grid-cols-2"><SkeletonCard className="h-72" /><SkeletonCard className="h-72" /></div>
      </div>
    );
  }

  const { totals } = s;
  const isCurrent = month === currentMonth();
  const slices = spendingSlices(s);
  const limited = s.categories.filter((c) => c.kind === 'expense' && c.monthly_limit).sort((a, b) => b.total / b.monthly_limit! - a.total / a.monthly_limit!);
  const over = limited.filter((c) => c.total > c.monthly_limit!);
  const delta = totals.prev_spent > 0 ? (totals.spent - totals.prev_spent) / totals.prev_spent : null;
  const dayOfMonth = isCurrent ? new Date().getDate() : daysInMonth(month);
  const pace = totals.budgeted > 0 ? totals.spent / totals.budgeted : null;
  const monthElapsed = dayOfMonth / daysInMonth(month);
  const openBills = (bills ?? []).filter((b) => b.kind === 'expense' && b.status !== 'paid' && b.status !== 'skipped').slice(0, 4);
  const activeGoals = (goals ?? []).filter((g) => !g.completed_at).slice(0, 3);
  const empty = totals.count === 0;
  const memberSpend = s.by_member.filter((m) => m.user_id && m.spent > 0);
  const maxMember = Math.max(1, ...memberSpend.map((m) => m.spent));

  return (
    <div className="flex flex-col gap-5">
      {over.length > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg">
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            {over.length === 1 ? (
              <span><span className="font-semibold">{over[0].name}</span> is {fmt(over[0].total - over[0].monthly_limit!)} over its {fmt(over[0].monthly_limit)} limit</span>
            ) : (
              <>
                <span className="font-semibold">{over.length} categories are over budget</span>
                <span className="opacity-90"> — {over.map((c) => `${c.name} +${fmt(c.total - c.monthly_limit!)}`).join(', ')}</span>
              </>
            )}
          </div>
        </div>
      )}

      <div className="grid [&>*]:min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Income" icon={<ArrowDownLeft size={14} />} tone="#12A594" value={fmt(totals.income)} hint={monthLabel(month)} />
        <Stat
          label="Spent"
          icon={<ArrowUpRight size={14} />}
          tone="#5B5BD6"
          value={fmt(totals.spent)}
          hint={delta === null ? `${totals.count} transactions` : `${delta > 0 ? '↑' : '↓'} ${Math.abs(Math.round(delta * 100))}% vs ${monthLabel(addMonths(month, -1), 'short')}`}
        />
        <Stat
          label="Balance"
          icon={<Scale size={14} />}
          tone={totals.balance >= 0 ? '#30A46C' : '#E5484D'}
          value={<span className={totals.balance < 0 ? 'text-danger' : undefined}>{fmt(totals.balance, { sign: true })}</span>}
          hint={totals.balance >= 0 ? 'Left over this month' : 'Spent more than earned'}
        />
        <Stat
          label="Budget used"
          icon={<Gauge size={14} />}
          tone="#F76B15"
          value={pace === null ? '—' : `${Math.round(pace * 100)}%`}
          hint={pace === null ? 'Set limits to track' : isCurrent ? `${Math.round(monthElapsed * 100)}% of the month gone` : `of ${fmt(totals.budgeted)}`}
        />
      </div>

      {empty ? (
        <Card>
          <EmptyState
            icon={Receipt}
            accent={mod.accent}
            title={`No transactions in ${monthLabel(month)}`}
            description="Add your first expense or income and the charts, limits and trends will fill in automatically."
            action={<Button icon={Plus} onClick={() => addTransaction()}>Add a transaction</Button>}
          />
        </Card>
      ) : (
        <div className="grid [&>*]:min-w-0 grid-cols-1 gap-5 lg:grid-cols-[1.1fr_1fr]">
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader title="Where the money went" subtitle={`${fmt(totals.spent)} across ${slices.length} categories`} icon={ChartPie} accent={mod.accent} />
              {slices.length ? <SpendingDonut slices={slices} total={totals.spent} fmt={fmt} /> : <p className="py-8 text-center text-sm text-muted">No spending this month.</p>}
            </Card>
            {memberSpend.length > 0 && (
              <Card>
                <CardHeader title="Who paid" subtitle="Spending by family member" icon={Receipt} accent="#8E4EC6" />
                <ul className="flex flex-col gap-3">
                  {memberSpend.map((m) => {
                    const member = members.find((x) => x.id === m.user_id);
                    if (!member) return null;
                    return (
                      <li key={m.user_id} className="flex items-center gap-3">
                        <Avatar user={member} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex justify-between text-sm"><span className="font-medium text-fg">{firstName(member.name)}</span><span className="font-semibold text-fg tabular">{fmt(m.spent)}</span></div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2 dark:bg-surface-3"><div className="h-full rounded-full" style={{ width: `${(m.spent / maxMember) * 100}%`, backgroundColor: member.color }} /></div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </div>
          <Card>
            <CardHeader
              title="Monthly limits"
              subtitle={totals.budgeted ? `${fmt(totals.spent)} of ${fmt(totals.budgeted)}` : 'No limits yet'}
              icon={Gauge}
              accent="#F76B15"
              action={canManage && <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={openCategories}>Edit</Button>}
            />
            {limited.length ? (
              <ul className="flex flex-col gap-3.5">
                {limited.slice(0, 8).map((c) => {
                  const overBy = c.total - c.monthly_limit!;
                  return (
                    <li key={c.id}>
                      <Link to={`/budget/transactions?month=${month}&category=${c.id}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
                        <div className="mb-1.5 flex items-center gap-2.5">
                          <CategoryIcon category={c} size="sm" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{c.name}</span>
                          <span className="shrink-0 text-[13px] tabular">
                            <span className={cn('font-semibold', overBy > 0 ? 'text-danger' : 'text-fg')}>{fmt(c.total)}</span>
                            <span className="text-muted"> / {fmt(c.monthly_limit)}</span>
                          </span>
                        </div>
                        <Progress value={c.total} max={c.monthly_limit!} color={c.color} label={`${c.name} budget`} warnAt={Math.min(0.9, Math.max(0.8, monthElapsed))} />
                        {overBy > 0 && <div className="mt-1 text-xs font-medium text-danger">{fmt(overBy)} over budget</div>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState compact icon={Gauge} accent="#F76B15" title="Set spending limits" description="Give categories a monthly limit to see how you're tracking." action={canManage ? <Button size="sm" variant="soft" onClick={openCategories}>Set limits</Button> : undefined} />
            )}
          </Card>
        </div>
      )}

      <div className="grid [&>*]:min-w-0 grid-cols-1 gap-5 lg:grid-cols-[1.25fr_1fr]">
        <Card>
          <CardHeader title="Last 6 months" subtitle="Income vs spending · tap a month to open it" icon={Scale} accent={mod.accent} />
          <TrendChart trend={s.trend} month={month} fmt={fmt} onSelect={setMonth} />
        </Card>
        <Card>
          <CardHeader
            title="Bills this month"
            subtitle={s.bills.total ? `${s.bills.paid} of ${s.bills.total} paid · ${fmt(s.bills.remaining)} to go` : 'Nothing recurring yet'}
            icon={CalendarClock}
            accent="#0090FF"
            action={<Link to={link('/bills')} className={buttonClass('ghost', 'sm')}>All <ArrowRight size={14} /></Link>}
          />
          {openBills.length ? (
            <ul className="-my-1 divide-y divide-border">{openBills.map((b) => <BillRow key={b.id} b={b} month={month} compact />)}</ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted">{s.bills.total ? 'All bills are settled — nice! 🎉' : 'Add rent, subscriptions and more on the Bills tab.'}</p>
          )}
        </Card>
      </div>

      <div className="grid [&>*]:min-w-0 grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader
            title="Recent transactions"
            icon={Receipt}
            accent={mod.accent}
            action={<Link to={link('/transactions')} className={buttonClass('ghost', 'sm')}>See all <ArrowRight size={14} /></Link>}
          />
          {!recent ? (
            <SkeletonList rows={4} />
          ) : recent.length ? (
            <ul className="-mx-2 -my-1 divide-y divide-border/70">{recent.slice(0, 6).map((t) => <TransactionRow key={t.id} t={t} onOpen={openTransaction} showDate />)}</ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No transactions yet.</p>
          )}
        </Card>
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Savings goals" icon={PiggyBank} accent="#30A46C" action={<Link to="/budget/goals" className={buttonClass('ghost', 'sm')}>All <ArrowRight size={14} /></Link>} />
            {activeGoals.length ? (
              <div className="flex flex-col gap-2.5">{activeGoals.map((g) => <GoalCard key={g.id} g={g} compact onOpen={() => navigate(`/budget/goals?goal=${g.id}`)} />)}</div>
            ) : (
              <p className="py-4 text-center text-sm text-muted">No goals yet. <Link to="/budget/goals" className="font-semibold text-primary">Start one</Link></p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
