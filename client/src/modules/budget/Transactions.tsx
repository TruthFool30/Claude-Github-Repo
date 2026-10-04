// Transactions tab: filters + day-grouped list.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Plus, Receipt, Search, SearchX, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { fmtDay, plural } from '../../lib/format';
import { useDebounce } from '../../lib/hooks';
import { Button, Card, EmptyState, IconButton, Input, MemberPicker, SegmentedControl, Select, SkeletonList } from '../../ui';
import { monthLabel, useCategories, useMoney, useMonthParam, useTransactions, type Kind } from './api';
import { useBudget } from './context';
import { TransactionRow } from './TransactionDetail';
import mod from './index';

export default function Transactions() {
  const [month] = useMonthParam();
  const { members } = useAuth();
  const { fmt } = useMoney();
  const { addTransaction, openTransaction } = useBudget();
  const { data: categories = [] } = useCategories();
  const [kind, setKind] = useState<Kind | ''>('');
  const [params] = useSearchParams();
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [categoryId, setCategoryId] = useState(() => params.get('category') ?? '');
  const [paidBy, setPaidBy] = useState<number | null>(null);
  const debounced = useDebounce(q.trim(), 250);
  const filters = { month, q: debounced.length >= 2 ? debounced : undefined, kind, category_id: categoryId || undefined, paid_by: paidBy };
  const list = useTransactions(filters);
  const { isLoading, isError, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = list;
  const data = useMemo(() => list.data?.pages.flatMap((p) => p.items), [list.data]);
  const filtered = !!(filters.q || kind || categoryId || paidBy);

  const groups = useMemo(() => {
    const map = new Map<string, NonNullable<typeof data>>();
    for (const t of data ?? []) {
      const g = map.get(t.date) ?? [];
      g.push(t);
      map.set(t.date, g);
    }
    return [...map.entries()];
  }, [data]);
  const totals = useMemo(() => {
    let income = 0;
    let spent = 0;
    for (const t of data ?? []) (t.kind === 'income' ? (income += t.amount) : (spent += t.amount));
    return { income, spent };
  }, [data]);

  const clear = () => {
    setQ('');
    setKind('');
    setCategoryId('');
    setPaidBy(null);
  };

  const catOptions = [
    { value: '', label: 'All categories' },
    ...categories.filter((c) => !kind || c.kind === kind).map((c) => ({ value: String(c.id), label: `${c.name}${c.kind === 'income' ? ' (income)' : ''}` })),
    { value: 'none', label: 'Uncategorized' },
  ];

  return (
    <div className="grid [&>*]:min-w-0 grid-cols-1 gap-5 lg:grid-cols-[1fr_300px] lg:items-start">
      <div className="min-w-0 lg:order-2">
        <Card padding="sm" className="flex flex-col gap-3 lg:sticky lg:top-24 lg:p-4">
          <Input
            icon={Search}
            placeholder="Search transactions"
            aria-label="Search transactions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            trailing={q ? <IconButton icon={X} label="Clear search" size="sm" onClick={() => setQ('')} /> : undefined}
          />
          <SegmentedControl
            block
            size="sm"
            aria-label="Type"
            value={kind || 'all'}
            onChange={(v) => {
              setKind(v === 'all' ? '' : (v as Kind));
              setCategoryId('');
            }}
            options={[{ value: 'all', label: 'All' }, { value: 'expense', label: 'Expenses' }, { value: 'income', label: 'Income' }]}
          />
          <Select aria-label="Category" size="sm" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} options={catOptions} />
          {members.length > 1 && (
            <div className="-mx-1 overflow-x-auto px-1 pb-0.5 scrollbar-none">
              <MemberPicker value={paidBy} onChange={setPaidBy} aria-label="Paid by" className="flex-nowrap lg:flex-wrap" />
            </div>
          )}
          {filtered && (
            <Button variant="ghost" size="sm" icon={X} onClick={clear} className="self-start">Clear filters</Button>
          )}
        </Card>
      </div>

      <div className="min-w-0 lg:order-1">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
          <h2 className="text-[15px] font-semibold text-fg" aria-live="polite">
            {filters.q ? `Results for “${filters.q}” in all months` : monthLabel(month)}
            {data && <span className="ml-2 font-normal text-muted">· {hasNextPage ? `${data.length}+ transactions` : plural(data.length, 'transaction')}</span>}
          </h2>
          {data && data.length > 0 && !hasNextPage && (
            <div className="flex gap-3 text-[13px] tabular">
              <span className="text-success-soft-fg">+{fmt(totals.income)}</span>
              <span className="text-muted">−{fmt(totals.spent)}</span>
            </div>
          )}
        </div>

        {isLoading ? (
          <Card><SkeletonList rows={7} /></Card>
        ) : isError ? (
          <Card>
            <EmptyState compact icon={Receipt} accent={mod.accent} title="Couldn't load transactions" description="Check your connection and try again." action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />
          </Card>
        ) : !data?.length ? (
          <Card>
            {filtered ? (
              <EmptyState icon={SearchX} accent={mod.accent} title="No matches" description="Try a different search or clear the filters." action={<Button variant="secondary" onClick={clear}>Clear filters</Button>} />
            ) : (
              <EmptyState
                icon={Receipt}
                accent={mod.accent}
                title={`Nothing in ${monthLabel(month)} yet`}
                description="Add expenses and income as they happen and Hearth will keep the totals for you."
                action={<Button icon={Plus} onClick={() => addTransaction()}>Add a transaction</Button>}
              />
            )}
          </Card>
        ) : (
          <div className={`flex flex-col gap-4 transition-opacity ${isFetching ? 'opacity-80' : ''}`}>
            {groups.map(([date, items]) => {
              const daySpent = items.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount, 0);
              return (
                <section key={date} aria-label={fmtDay(date)}>
                  <div className="mb-1.5 flex items-center justify-between px-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">
                    <span>{fmtDay(date)}</span>
                    {daySpent > 0 && <span className="tabular normal-case tracking-normal">−{fmt(daySpent)}</span>}
                  </div>
                  <Card padding="none" className="p-1.5">
                    <ul className="divide-y divide-border/70">
                      {items.map((t) => <TransactionRow key={t.id} t={t} onOpen={openTransaction} showDate={!!filters.q} />)}
                    </ul>
                  </Card>
                </section>
              );
            })}
            {hasNextPage && (
              <Button variant="secondary" className="self-center" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
                Load more
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
