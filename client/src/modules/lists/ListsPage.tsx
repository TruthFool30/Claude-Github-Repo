import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { useIsDesktop } from '../../lib/hooks';
import ListDetailPage from './ListDetail';
import MyTasksPage from './MyTasks';
import Overview from './Overview';
import { Rail } from './Rail';
import { useListsLive } from './data';

// Module-local keyframes (shared CSS is owned by the foundation).
const STYLE = `
@keyframes lists-flash {
  0%, 30% { background-color: color-mix(in oklab, var(--warning) 22%, var(--surface)); box-shadow: 0 0 0 2px color-mix(in oklab, var(--warning) 45%, transparent); }
  100% { background-color: var(--surface); box-shadow: 0 0 0 0 transparent; }
}`;

function WithRail({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  if (!desktop) return <>{children}</>;
  return (
    <div className="grid grid-cols-[232px_minmax(0,1fr)] gap-8">
      <Rail />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export default function ListsPage() {
  useListsLive();
  return (
    <>
      <style>{STYLE}</style>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="my-tasks" element={<WithRail><MyTasksPage /></WithRail>} />
        <Route path=":id" element={<WithRail><ListDetailPage /></WithRail>} />
      </Routes>
    </>
  );
}
