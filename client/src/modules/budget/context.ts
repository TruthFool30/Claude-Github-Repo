import { createContext, useContext } from 'react';
import type { Transaction } from './api';
import type { TxDraft } from './TransactionForm';

export interface BudgetActions {
  addTransaction: (draft?: TxDraft) => void;
  openTransaction: (t: Transaction) => void;
  editTransaction: (t: Transaction) => void;
  openCategories: () => void;
}

export const BudgetContext = createContext<BudgetActions | null>(null);

export function useBudget(): BudgetActions {
  const ctx = useContext(BudgetContext);
  if (!ctx) throw new Error('useBudget must be used inside the budget page');
  return ctx;
}
