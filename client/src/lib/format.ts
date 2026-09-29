import {
  differenceInCalendarDays, format, formatDistanceToNowStrict, isThisYear, isToday, isTomorrow, isYesterday, parseISO,
} from 'date-fns';

export type DateInput = string | number | Date | null | undefined;

/**
 * Parse API dates. 'YYYY-MM-DD' is treated as a LOCAL calendar date (not UTC midnight);
 * full ISO timestamps are parsed normally.
 */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = parseISO(value.includes('T') || value.includes('Z') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local date -> 'YYYY-MM-DD'. */
export function toDateKey(value: DateInput = new Date()): string {
  const d = toDate(value);
  return d ? format(d, 'yyyy-MM-dd') : '';
}

/** "Mon, Sep 29" (adds the year when not this year). Pass a date-fns pattern to override. */
export function fmtDate(value: DateInput, pattern?: string): string {
  const d = toDate(value);
  if (!d) return '';
  if (pattern) return format(d, pattern);
  return format(d, isThisYear(d) ? 'EEE, MMM d' : 'EEE, MMM d, yyyy');
}

/** "3:30 PM" */
export function fmtTime(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '';
  return format(d, d.getMinutes() === 0 ? 'h a' : 'h:mm a');
}

/** "Today, 3:30 PM" / "Tue, Oct 4, 9 AM" */
export function fmtDateTime(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '';
  return `${fmtDay(d)}, ${fmtTime(d)}`;
}

/** "Today" / "Tomorrow" / "Yesterday" / "Thursday" (within a week) / "Mon, Sep 29" */
export function fmtDay(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '';
  if (isToday(d)) return 'Today';
  if (isTomorrow(d)) return 'Tomorrow';
  if (isYesterday(d)) return 'Yesterday';
  const diff = differenceInCalendarDays(d, new Date());
  if (diff > 1 && diff < 7) return format(d, 'EEEE');
  return fmtDate(d);
}

/** "just now" / "5m ago" / "3h ago" / "yesterday" / "Sep 12" */
export function fmtRelative(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '';
  const seconds = (Date.now() - d.getTime()) / 1000;
  if (seconds < 0) {
    return `in ${formatDistanceToNowStrict(d)}`;
  }
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400 && isToday(d)) return `${Math.round(seconds / 3600)}h ago`;
  if (isYesterday(d)) return 'yesterday';
  if (seconds < 7 * 86400) return format(d, 'EEEE');
  return format(d, isThisYear(d) ? 'MMM d' : 'MMM d, yyyy');
}

/** fmtMoney(12.5, 'USD') -> "$12.50". `compact` -> "$1.2K". */
export function fmtMoney(amount: number | null | undefined, currency = 'USD', opts: { compact?: boolean; sign?: boolean } = {}): string {
  const n = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: opts.compact ? 'compact' : 'standard',
      maximumFractionDigits: opts.compact ? 1 : 2,
      minimumFractionDigits: opts.compact ? 0 : Number.isInteger(n) && Math.abs(n) >= 1000 ? 0 : 2,
      signDisplay: opts.sign ? 'exceptZero' : 'auto',
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** "Alex Rivera" -> "AR", "mia" -> "M" */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** First name only. */
export const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';

/** "3 items" / "1 item" */
export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;

/** Age in years from a 'YYYY-MM-DD' birthday. */
export function age(birthday: string | null | undefined): number | null {
  const d = toDate(birthday);
  if (!d) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}

/** Human file size: 1536 -> "1.5 KB" */
export function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
