import { CalendarClock, CalendarDays } from 'lucide-react';
import { differenceInCalendarDays, format } from 'date-fns';
import { cn } from '../../lib/cn';
import { toDate } from '../../lib/format';

/** Emoji tile tinted with the list color. */
export function ListTile({ icon, color, size = 44, className }: { icon: string; color: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-[30%]', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        background: `linear-gradient(145deg, color-mix(in oklab, ${color} 14%, var(--surface)), color-mix(in oklab, ${color} 28%, var(--surface)))`,
        border: `1px solid color-mix(in oklab, ${color} 25%, transparent)`,
      }}
    >
      {icon}
    </span>
  );
}

/** Circular progress with the percentage (or a check when complete). */
export function ProgressRing({ done, total, color, size = 44 }: { done: number; total: number; color: string; size?: number }) {
  const pct = total ? done / total : 0;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const complete = total > 0 && done === total;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-hidden>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-surface-3" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 500ms cubic-bezier(0.3,1,0.4,1)' }}
        />
      </svg>
      <span className="absolute text-[11px] font-bold tabular-nums text-fg">{complete ? '🎉' : `${Math.round(pct * 100)}%`}</span>
    </span>
  );
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later';

export function dueInfo(due: string | null, done = false): { label: string; tone: DueTone } | null {
  const d = toDate(due);
  if (!d) return null;
  const diff = differenceInCalendarDays(d, new Date());
  let label: string;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff > 1 && diff < 7) label = format(d, 'EEEE');
  else if (diff < -1 && diff > -7) label = `${-diff} days ago`;
  else label = format(d, d.getFullYear() === new Date().getFullYear() ? 'MMM d' : 'MMM d, yyyy');
  const tone: DueTone = done ? 'later' : diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 2 ? 'soon' : 'later';
  return { label, tone };
}

const toneCls: Record<DueTone, string> = {
  overdue: 'bg-danger-soft text-danger-soft-fg',
  today: 'bg-warning-soft text-warning-soft-fg',
  soon: 'bg-info-soft text-info-soft-fg',
  later: 'bg-surface-2 text-muted',
};

export function DueChip({ due, done, className }: { due: string | null; done?: boolean; className?: string }) {
  const info = dueInfo(due, done);
  if (!info) return null;
  const Icon = info.tone === 'overdue' ? CalendarClock : CalendarDays;
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', toneCls[info.tone], className)}>
      <Icon size={11} aria-hidden />
      <span>
        <span className="sr-only">{info.tone === 'overdue' ? 'Overdue, due ' : 'Due '}</span>
        {info.label}
      </span>
    </span>
  );
}

/** Quick due-date presets. */
export function duePresets(): Array<{ label: string; value: string }> {
  const now = new Date();
  const add = (n: number) => format(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n), 'yyyy-MM-dd');
  const dow = now.getDay(); // 0 Sun
  const toSat = dow === 6 ? 7 : 6 - dow;
  const toMon = ((8 - dow) % 7) || 7;
  return [
    { label: 'Today', value: add(0) },
    { label: 'Tomorrow', value: add(1) },
    { label: 'Weekend', value: add(toSat) },
    { label: 'Next week', value: add(toMon) },
  ];
}

/** Local persisted boolean (per-viewer convenience; never throws). */
export function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
export function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}
