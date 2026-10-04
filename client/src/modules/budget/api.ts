// Budget data layer: API types, query hooks and month helpers.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtMoney, toDateKey } from '../../lib/format';

export type Kind = 'expense' | 'income';

export interface CategoryRef {
  id: number;
  name: string;
  icon: string;
  color: string;
  kind: Kind;
}

export interface Category extends CategoryRef {
  monthly_limit: number | null;
  sort: number;
  created_at: string;
}

export interface Transaction {
  id: number;
  kind: Kind;
  amount: number;
  category_id: number | null;
  category: CategoryRef | null;
  description: string | null;
  date: string;
  paid_by: number | null;
  receipt_url: string | null;
  notes: string | null;
  recurring_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface SummaryCategory extends Category {
  total: number;
  count: number;
}

export interface Summary {
  month: string;
  currency: string;
  totals: { income: number; spent: number; balance: number; prev_spent: number; budgeted: number; count: number };
  categories: SummaryCategory[];
  uncategorized: { expense: number; income: number };
  trend: Array<{ month: string; income: number; spent: number }>;
  by_member: Array<{ user_id: number | null; spent: number; count: number }>;
  daily: Array<{ date: string; spent: number }>;
  bills: { total: number; paid: number; due: number; remaining: number };
}

export type BillStatus = 'paid' | 'skipped' | 'overdue' | 'due_today' | 'upcoming';

export interface Bill {
  id: number;
  kind: Kind;
  description: string;
  amount: number;
  category_id: number | null;
  category: CategoryRef | null;
  day_of_month: number;
  paid_by: number | null;
  auto_create: boolean;
  start_month: string;
  end_month: string | null;
  active: boolean;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  month: string;
  due_date: string;
  status: BillStatus;
  transaction_id: number | null;
  paid_amount: number | null;
  paid_date: string | null;
}

export interface GoalEntry {
  id: number;
  amount: number;
  note: string | null;
  source: 'manual' | 'allowance';
  user_id: number | null;
  created_at: string;
}

export interface Goal {
  id: number;
  name: string;
  emoji: string | null;
  color: string;
  target: number;
  saved: number;
  owner_id: number | null;
  target_date: string | null;
  completed_at: string | null;
  created_by: number | null;
  created_at: string;
  entry_count: number;
  last_entry_at: string | null;
  entries?: GoalEntry[];
}

export interface Allowance {
  id: number;
  member_id: number;
  amount: number;
  frequency: 'weekly' | 'monthly';
  goal_id: number | null;
  last_paid_at: string | null;
  created_at: string;
}

export interface TxFilters {
  month: string;
  q?: string;
  category_id?: string;
  paid_by?: number | null;
  kind?: Kind | '';
}

// ---- keys + hooks -----------------------------------------------------------------------------

export const keys = {
  all: ['budget'] as const,
  summary: (month: string) => ['budget', 'summary', month] as const,
  categories: ['budget', 'categories'] as const,
  transactions: (f: TxFilters) => ['budget', 'transactions', f] as const,
  transactionsRoot: ['budget', 'transactions'] as const,
  transaction: (id: number) => ['budget', 'transaction', id] as const,
  bills: (month: string) => ['budget', 'bills', month] as const,
  goals: ['budget', 'goals'] as const,
  goal: (id: number) => ['budget', 'goal', id] as const,
  allowances: ['budget', 'allowances'] as const,
  badge: ['budget', 'badge'] as const,
};

/**
 * The browser's local calendar day + UTC offset. Sent with budget requests so bill statuses,
 * the nav badge and default dates follow the family's clock, not the server's.
 */
export const localDay = () => ({ today: toDateKey() });

export const useSummary = (month: string) =>
  useQuery({ queryKey: keys.summary(month), queryFn: () => api.get<Summary>(`/budget/summary${qs({ month, ...localDay() })}`), placeholderData: (p) => p });

export const useCategories = () =>
  useQuery({ queryKey: keys.categories, queryFn: () => api.get<Category[]>('/budget/categories'), staleTime: 60_000 });

export interface TxPage {
  items: Transaction[];
  next_cursor: string | null;
}

/** Recent transactions of a month (first `limit`). */
export const useRecentTransactions = (month: string, limit = 6) =>
  useQuery({
    queryKey: [...keys.transactionsRoot, 'recent', month, limit],
    queryFn: () => api.get<Transaction[]>(`/budget/transactions${qs({ month, limit })}`),
    placeholderData: (p) => p,
  });

/** Filtered, paginated transaction list ("Load more"). */
export const useTransactions = (f: TxFilters) =>
  useInfiniteQuery({
    queryKey: keys.transactions(f),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<TxPage>(
        `/budget/transactions${qs({
          month: f.month, q: f.q, category_id: f.category_id, paid_by: f.paid_by ?? undefined, kind: f.kind, all: f.q ? 1 : undefined,
          page: 1, limit: 100, cursor: pageParam,
        })}`,
      ),
    getNextPageParam: (last) => last.next_cursor,
    placeholderData: (p) => p,
  });

export const useBills = (month: string) =>
  useQuery({ queryKey: keys.bills(month), queryFn: () => api.get<Bill[]>(`/budget/recurring${qs({ month, ...localDay() })}`), placeholderData: (p) => p });

export const useGoals = () => useQuery({ queryKey: keys.goals, queryFn: () => api.get<Goal[]>('/budget/goals') });

export const useGoal = (id: number | null) =>
  useQuery({ queryKey: keys.goal(id ?? 0), queryFn: () => api.get<Goal>(`/budget/goals/${id}`), enabled: !!id });

export const useAllowances = () => useQuery({ queryKey: keys.allowances, queryFn: () => api.get<Allowance[]>('/budget/allowances') });

/** Currency formatter bound to this family's currency. */
export function useMoney() {
  const { family } = useAuth();
  const currency = family?.currency ?? 'USD';
  // Always the currency's normal decimals ($1,250.00, not $1,250) so amounts line up in lists.
  const fmt = (n: number | null | undefined, opts?: { compact?: boolean; sign?: boolean }) => {
    if (opts?.compact) return fmtMoney(n, currency, opts);
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, signDisplay: opts?.sign ? 'exceptZero' : 'auto' }).format(Number(n ?? 0));
    } catch {
      return fmtMoney(n, currency, opts);
    }
  };
  return { currency, fmt };
}

/** Whether the current user may manage categories, bills and allowances. */
export function useCanManage() {
  const { role } = useAuth();
  return role !== 'child';
}

// ---- month helpers ----------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
export const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const isMonth = (s: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function monthDate(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
export const monthLabel = (month: string, style: 'long' | 'short' = 'long') =>
  monthDate(month).toLocaleString(undefined, style === 'long' ? { month: 'long', year: 'numeric' } : { month: 'short' });
export const daysInMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

/** `?month=` search param shared by every budget tab (defaults to this month). */
export function useMonthParam(): [string, (m: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('month');
  const month = isMonth(raw) ? raw : currentMonth();
  const setMonth = (m: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (m === currentMonth()) next.delete('month');
        else next.set('month', m);
        return next;
      },
      { replace: true },
    );
  return [month, setMonth];
}

/** The locale's decimal separator ("." or ","). */
export const decimalSeparator = () => (1.5).toLocaleString(undefined).includes(',') ? ',' : '.';

/**
 * Parse a user-typed amount → number or null. Accepts "12", "12.5", "1,234.56", "1.234,56",
 * "12,50" (a single comma followed by 1–2 digits is a decimal comma) and "1 234,5".
 */
export function parseAmount(input: string): number | null {
  let s = input.replace(/[\s\u00a0']/g, '').replace(/^[^\d.,]+/, '');
  if (!s || !/^[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal separator.
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    const decimalComma = parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2;
    s = decimalComma ? parts.join('.') : parts.join('');
  } else if (lastDot >= 0 && s.split('.').length > 2) {
    s = s.split('.').join(''); // "1.234.567" thousands dots
  }
  if (!/^\d+(\.\d{1,2})?$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Number → string for an amount input, using the locale's decimal separator ("12,5" in de-DE). */
export const amountToInput = (n: number) => (decimalSeparator() === ',' ? String(n).replace('.', ',') : String(n));

/** Currency symbol for input adornments ("$", "€", "RM"…). */
export function currencySymbol(currency: string) {
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}
