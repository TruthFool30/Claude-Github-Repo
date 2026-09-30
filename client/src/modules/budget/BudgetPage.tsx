// Budget module shell: header with month navigation, tabs (Overview / Transactions / Bills / Goals),
// shared add/edit/detail sheets and live updates.
import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router';
import { CalendarClock, ChartPie, ChevronLeft, ChevronRight, PiggyBank, Plus, Receipt, SlidersHorizontal } from 'lucide-react';
import { useLive } from '../../lib/live';
import { Button, Fab, IconButton, Menu, PageHeader, SegmentedControl, Tabs } from '../../ui';
import { addMonths, currentMonth, monthLabel, useBills, useCanManage, useMonthParam, type Transaction } from './api';
import Bills from './Bills';
import { CategoryManager } from './Categories';
import { BudgetContext, type BudgetActions } from './context';
import Goals from './Goals';
import Overview from './Overview';
import { TransactionDetail } from './TransactionDetail';
import { TransactionForm, type TxDraft } from './TransactionForm';
import Transactions from './Transactions';
import mod from './index';

type Tab = 'overview' | 'transactions' | 'bills' | 'goals';

function MonthNav({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const isCurrent = month === currentMonth();
  return (
    <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-xs">
      <IconButton icon={ChevronLeft} label="Previous month" size="sm" onClick={() => setMonth(addMonths(month, -1))} />
      <span className="min-w-[8.5rem] text-center text-sm font-semibold text-fg tabular" aria-live="polite">{monthLabel(month)}</span>
      <IconButton icon={ChevronRight} label="Next month" size="sm" onClick={() => setMonth(addMonths(month, 1))} disabled={month >= addMonths(currentMonth(), 12)} />
      {!isCurrent && (
        <Button size="sm" variant="ghost" onClick={() => setMonth(currentMonth())} className="px-2">Today</Button>
      )}
    </div>
  );
}

export default function BudgetPage() {
  useLive('budget');
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useMonthParam();
  const canManage = useCanManage();
  const { data: bills } = useBills(month);
  const due = (bills ?? []).filter((b) => b.status === 'overdue' || b.status === 'due_today').length;

  const [form, setForm] = useState<{ open: boolean; editing: Transaction | null; draft?: TxDraft }>({ open: false, editing: null });
  const [detailInitial, setDetailInitial] = useState<Transaction | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const txId = Number(params.get('tx')) || null;

  const tab: Tab = (['transactions', 'bills', 'goals'] as const).find((t) => location.pathname.startsWith(`/budget/${t}`)) ?? 'overview';
  const setTab = (t: Tab) => {
    const q = month !== currentMonth() && t !== 'goals' ? `?month=${month}` : '';
    navigate(`/budget${t === 'overview' ? '' : `/${t}`}${q}`);
  };

  const setTx = (id: number | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id) n.set('tx', String(id));
      else n.delete('tx');
      return n;
    });

  const actions: BudgetActions = useMemo(
    () => ({
      addTransaction: (draft) => setForm({ open: true, editing: null, draft }),
      openTransaction: (t) => {
        setDetailInitial(t);
        setTx(t.id);
      },
      editTransaction: (t) => setForm({ open: true, editing: t }),
      openCategories: () => setCategoriesOpen(true),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // "N" adds a transaction (when not typing in a field and no dialog is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      actions.addTransaction(month !== currentMonth() ? { date: `${month}-01` } : undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, month]);

  const draftForMonth = month !== currentMonth() ? { date: `${month}-01` } : undefined;

  return (
    <BudgetContext.Provider value={actions}>
      <div className="pb-24 lg:pb-0">
        <PageHeader
          title={mod.label}
          subtitle={tab === 'goals' ? 'Savings goals & allowances' : `${monthLabel(month)} · shared family budget`}
          icon={mod.icon}
          accent={mod.accent}
          actions={
            <>
              {tab !== 'goals' && <div className="hidden sm:block"><MonthNav month={month} setMonth={setMonth} /></div>}
              <div className="hidden lg:block">
                <Button icon={Plus} onClick={() => actions.addTransaction(draftForMonth)} title="Add transaction (N)">
                  Add transaction
                </Button>
              </div>
              <Menu
                label="Budget options"
                items={[
                  { label: 'Categories & limits', icon: SlidersHorizontal, onSelect: () => setCategoriesOpen(true) },
                  canManage && { label: 'Monthly bills', icon: CalendarClock, onSelect: () => setTab('bills') },
                  { label: 'Savings goals', icon: PiggyBank, onSelect: () => setTab('goals') },
                ]}
              />
            </>
          }
        >
          <div className="hidden sm:block">
            <Tabs<Tab>
              accent={mod.accent}
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'overview', label: 'Overview', icon: ChartPie },
                { id: 'transactions', label: 'History', icon: Receipt },
                { id: 'bills', label: 'Bills', icon: CalendarClock, count: canManage && due ? due : undefined },
                { id: 'goals', label: 'Goals', icon: PiggyBank },
              ]}
            />
          </div>
          {/* Phones: all four sections always visible as a segmented control. */}
          <nav aria-label="Budget sections" className="sm:hidden">
            <SegmentedControl<Tab>
              block
              size="sm"
              aria-label="Budget sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'overview', label: 'Overview' },
                { value: 'transactions', label: 'History' },
                {
                  value: 'bills',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      Bills
                      {canManage && due > 0 && (
                        <span className="rounded-full bg-danger-solid px-1.5 text-[10px] font-bold leading-4 text-white tabular" aria-label={`${due} need attention`}>{due}</span>
                      )}
                    </span>
                  ),
                },
                { value: 'goals', label: 'Goals' },
              ]}
            />
          </nav>
          {tab !== 'goals' && (
            <div className="mt-3 flex justify-center sm:hidden">
              <MonthNav month={month} setMonth={setMonth} />
            </div>
          )}
        </PageHeader>

        <Routes>
          <Route index element={<Overview />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="bills" element={<Bills />} />
          <Route path="goals" element={<Goals />} />
          <Route path="*" element={<Navigate to="/budget" replace />} />
        </Routes>

        {tab !== 'goals' && <Fab label="Add transaction" accent={mod.accent} onClick={() => actions.addTransaction(draftForMonth)} />}

        <TransactionForm
          open={form.open}
          editing={form.editing}
          draft={form.draft}
          onClose={() => setForm((f) => ({ ...f, open: false }))}
          onReceiptRetry={(t) => setForm({ open: true, editing: t })}
        />
        <TransactionDetail
          id={form.open ? null : txId}
          initial={detailInitial}
          onClose={() => setTx(null)}
          onEdit={(t) => {
            setTx(null);
            setForm({ open: true, editing: t });
          }}
        />
        <CategoryManager open={categoriesOpen} onClose={() => setCategoriesOpen(false)} />
      </div>
    </BudgetContext.Provider>
  );
}
