// Recharts visualisations: spending donut (by category) and 6-month income vs spending bars.
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '../../lib/cn';
import { monthLabel, type Summary } from './api';
import { UNCATEGORIZED } from './shared';

const OTHER_COLOR = '#8D90A0';
export const INCOME_COLOR = '#12A594';
export const SPENT_COLOR = '#5B5BD6';

export interface Slice {
  key: string;
  name: string;
  value: number;
  color: string;
  id: number | null;
}

/** Top 5 categories + "Everything else" (never more than 6 segments). */
export function spendingSlices(s: Summary): Slice[] {
  const rows: Slice[] = s.categories
    .filter((c) => c.kind === 'expense' && c.total > 0)
    .map((c) => ({ key: String(c.id), name: c.name, value: c.total, color: c.color, id: c.id }));
  if (s.uncategorized.expense > 0) rows.push({ key: 'none', name: UNCATEGORIZED.name, value: s.uncategorized.expense, color: UNCATEGORIZED.color, id: null });
  rows.sort((a, b) => b.value - a.value);
  if (rows.length <= 6) return rows;
  const rest = rows.slice(5);
  return [...rows.slice(0, 5), { key: 'rest', name: `${rest.length} more`, value: rest.reduce((t, r) => t + r.value, 0), color: OTHER_COLOR, id: null }];
}

function TipBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-surface px-3 py-2 text-[13px] shadow-pop">{children}</div>;
}

export function SpendingDonut({ slices, total, fmt }: { slices: Slice[]; total: number; fmt: (n: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const shown = active !== null ? slices[active] : null;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div className="relative size-[184px] shrink-0" role="img" aria-label={`Spending by category: ${slices.map((s) => `${s.name} ${fmt(s.value)}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={62}
              outerRadius={88}
              paddingAngle={slices.length > 1 ? 1.5 : 0}
              cornerRadius={4}
              stroke="var(--surface)"
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
              isAnimationActive
              animationDuration={700}
              onMouseEnter={(_, i) => setActive(i)}
              onMouseLeave={() => setActive(null)}
            >
              {slices.map((s, i) => (
                <Cell key={s.key} fill={s.color} opacity={active === null || active === i ? 1 : 0.35} className="outline-none transition-opacity" />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="max-w-[120px] truncate text-xs font-medium text-muted">{shown ? shown.name : 'Spent'}</span>
          <span className="text-xl font-bold tracking-tight text-fg tabular">{fmt(shown ? shown.value : total)}</span>
          {shown && total > 0 && <span className="text-xs text-muted tabular">{Math.round((shown.value / total) * 100)}%</span>}
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1">
        {slices.map((s, i) => (
          <li
            key={s.key}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors', active === i && 'bg-surface-2')}
          >
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-fg">{s.name}</span>
            <span className="shrink-0 text-xs text-muted tabular">{total > 0 ? Math.round((s.value / total) * 100) : 0}%</span>
            <span className="shrink-0 text-right font-semibold text-fg tabular">{fmt(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TrendChart({
  trend, month, fmt, onSelect,
}: { trend: Summary['trend']; month: string; fmt: (n: number, o?: { compact?: boolean }) => string; onSelect: (m: string) => void }) {
  const data = trend.map((t) => ({ ...t, label: monthLabel(t.month, 'short') }));
  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-[13px] text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ backgroundColor: INCOME_COLOR }} />Income</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ backgroundColor: SPENT_COLOR }} />Spent</span>
      </div>
      <div className="h-[220px] w-full" role="img" aria-label={`Income and spending, last 6 months: ${data.map((d) => `${d.label} income ${fmt(d.income)}, spent ${fmt(d.spent)}`).join('; ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2} barCategoryGap="26%" margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--subtle)', fontSize: 12 }} dy={4} />
            <YAxis tickLine={false} axisLine={false} width={52} tick={{ fill: 'var(--subtle)', fontSize: 11 }} tickFormatter={(v: number) => fmt(v, { compact: true })} />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)', radius: 8 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as (typeof data)[number];
                return (
                  <TipBox>
                    <div className="mb-1 font-semibold text-fg">{monthLabel(d.month)}</div>
                    <div className="flex items-center gap-2 text-muted"><span className="size-2 rounded-sm" style={{ backgroundColor: INCOME_COLOR }} />Income <span className="ml-auto pl-4 font-semibold text-fg tabular">{fmt(d.income)}</span></div>
                    <div className="flex items-center gap-2 text-muted"><span className="size-2 rounded-sm" style={{ backgroundColor: SPENT_COLOR }} />Spent <span className="ml-auto pl-4 font-semibold text-fg tabular">{fmt(d.spent)}</span></div>
                    <div className="mt-1 border-t border-border pt-1 text-muted">Balance <span className="float-right pl-4 font-semibold text-fg tabular">{fmt(d.income - d.spent)}</span></div>
                  </TipBox>
                );
              }}
            />
            <Bar dataKey="income" name="Income" radius={[4, 4, 0, 0]} maxBarSize={22} onClick={(d) => onSelect((d as unknown as { month: string }).month)} className="cursor-pointer">
              {data.map((d) => <Cell key={d.month} fill={INCOME_COLOR} fillOpacity={d.month === month ? 1 : 0.45} />)}
            </Bar>
            <Bar dataKey="spent" name="Spent" radius={[4, 4, 0, 0]} maxBarSize={22} onClick={(d) => onSelect((d as unknown as { month: string }).month)} className="cursor-pointer">
              {data.map((d) => <Cell key={d.month} fill={SPENT_COLOR} fillOpacity={d.month === month ? 1 : 0.45} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
