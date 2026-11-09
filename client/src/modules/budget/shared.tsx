// Small building blocks shared by the budget screens.
import type { ReactNode } from 'react';
import {
  Baby, Banknote, Book, Briefcase, Car, CircleDashed, Coffee, Dog, Dumbbell, Fuel, Gamepad2, Gift, GraduationCap, HandCoins,
  HeartPulse, House, Landmark, Lock, Music, PiggyBank, Plane, Receipt, ShieldCheck, Shirt, ShoppingBag, ShoppingCart, Smartphone,
  Sparkles, Ticket, Users, Utensils, Wifi, Wrench, Zap, type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { Input, useFieldControl } from '../../ui';
import { currencySymbol, type CategoryRef, type TxVisibility } from './api';

/** Mirrors ICONS in server/src/modules/budget/lib.js. */
export const ICONS: Record<string, LucideIcon> = {
  'shopping-cart': ShoppingCart, home: House, zap: Zap, car: Car, baby: Baby, 'heart-pulse': HeartPulse, utensils: Utensils,
  ticket: Ticket, 'shopping-bag': ShoppingBag, 'piggy-bank': PiggyBank, 'circle-dashed': CircleDashed, briefcase: Briefcase,
  gift: Gift, plane: Plane, 'graduation-cap': GraduationCap, dog: Dog, dumbbell: Dumbbell, coffee: Coffee, wifi: Wifi,
  smartphone: Smartphone, book: Book, music: Music, wrench: Wrench, sparkles: Sparkles, banknote: Banknote, shirt: Shirt,
  gamepad: Gamepad2, fuel: Fuel, receipt: Receipt, 'hand-coins': HandCoins,
};
export const ICON_KEYS = Object.keys(ICONS);
export const UNCATEGORIZED = { name: 'Uncategorized', icon: 'circle-dashed', color: '#8D90A0' };

export function CategoryIcon({
  category, size = 'md', className,
}: { category: Pick<CategoryRef, 'icon' | 'color'> | null | undefined; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const c = category ?? UNCATEGORIZED;
  const Icon = ICONS[c.icon] ?? CircleDashed;
  const box = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-12 rounded-2xl' }[size];
  const px = { sm: 16, md: 19, lg: 22 }[size];
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center', box, className)}
      style={{ backgroundColor: `color-mix(in oklab, ${c.color} 15%, transparent)`, color: `color-mix(in oklab, ${c.color} 80%, var(--fg))` }}
    >
      <Icon size={px} />
    </span>
  );
}

/** Horizontal progress bar; turns red when over 100%. */
export function Progress({
  value, max, color, className, label, warnAt = 0.85,
}: { value: number; max: number; color?: string; className?: string; label?: string; warnAt?: number }) {
  const ratio = max > 0 ? value / max : 0;
  const over = ratio > 1;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const fill = over ? 'var(--danger)' : ratio >= warnAt ? 'var(--warning)' : color ?? 'var(--primary)';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-2 dark:bg-surface-3', className)}
    >
      <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${pct}%`, backgroundColor: fill }} />
    </div>
  );
}

/** Circular progress ring (goals). */
export function Ring({ ratio, color, size = 64, stroke = 7, children }: { ratio: number; color: string; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, Math.max(0, ratio));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

/** Big amount input with a currency adornment. */
export function MoneyInput({
  value, onChange, currency, size = 'lg', autoFocus, invalid, id, name = 'amount', placeholder = '0.00', ariaLabel,
}: {
  value: string; onChange: (v: string) => void; currency: string; size?: 'md' | 'lg'; autoFocus?: boolean; invalid?: boolean;
  id?: string; name?: string; placeholder?: string; ariaLabel?: string;
}) {
  const symbol = currencySymbol(currency);
  const field = useFieldControl();
  if (size === 'md') {
    return (
      <Input
        id={id} name={name} inputMode="decimal" autoComplete="off" value={value} placeholder={placeholder} invalid={invalid}
        aria-label={ariaLabel} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
        icon={<span className="text-sm font-semibold">{symbol}</span>}
      />
    );
  }
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-2xl border bg-surface-2/60 px-4 py-3 transition focus-within:border-primary focus-within:ring-4 focus-within:ring-ring/60',
        invalid ? 'border-danger' : 'border-border',
      )}
    >
      <span className="text-2xl font-semibold text-subtle">{symbol}</span>
      <input
        id={id ?? field?.id} name={name} aria-describedby={field?.describedBy} inputMode="decimal" autoComplete="off" autoFocus={autoFocus} value={value} placeholder={placeholder}
        aria-label={ariaLabel} aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
        className="min-w-0 flex-1 bg-transparent text-[32px] font-bold tracking-tight text-fg tabular outline-none placeholder:text-subtle/60"
      />
    </div>
  );
}

/** Signed money text: income green with "+", expense in normal ink with "−". */
export function Amount({ kind, value, fmt, className }: { kind: 'expense' | 'income'; value: number; fmt: (n: number) => string; className?: string }) {
  return (
    <span className={cn('whitespace-nowrap font-semibold tabular', kind === 'income' ? 'text-success-soft-fg' : 'text-fg', className)}>
      {kind === 'income' ? '+' : '−'}
      {fmt(value)}
    </span>
  );
}

/** Stat tile used in the overview header. */
export function Stat({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2 text-[13px] font-medium text-muted">
        {icon && (
          <span className="flex size-6 items-center justify-center rounded-lg" style={tone ? { backgroundColor: `color-mix(in oklab, ${tone} 15%, transparent)`, color: tone } : undefined}>
            {icon}
          </span>
        )}
        {label}
      </div>
      <div className="mt-2 truncate text-[22px] font-bold tracking-tight text-fg tabular sm:text-2xl">{value}</div>
      {hint && <div className="mt-1 truncate text-xs text-muted">{hint}</div>}
    </div>
  );
}

// ponytail: same wording/look as the vault's VisibilityPicker (modules can't import each other's code).
export const VISIBILITY: Record<TxVisibility, { label: string; icon: LucideIcon; hint: string }> = {
  family: { label: 'Everyone', icon: Users, hint: 'Everyone in the family can see it' },
  adults: { label: 'Adults only', icon: ShieldCheck, hint: 'Hidden from children' },
  private: { label: 'Only me', icon: Lock, hint: 'Nobody else can see or find it' },
};

/** Stacked radio list "Who can see …" (vault style). */
export function VisibilityChoice<V extends TxVisibility>({ value, onChange, options, what = 'it' }: {
  value: V; onChange: (v: V) => void; options: readonly V[]; what?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-fg">Who can see {what}</span>
      <div role="radiogroup" aria-label={`Who can see ${what}`} className="flex flex-col gap-1">
        {options.map((v) => {
          const V = VISIBILITY[v];
          const on = v === value;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(v)}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                on ? 'border-primary bg-primary-soft/60' : 'border-border hover:bg-surface-2',
              )}
            >
              <V.icon size={17} className={on ? 'text-primary' : 'text-muted'} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-fg">{V.label}</span>
                <span className="block text-xs text-muted">{V.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "Adults only" / "Only me" pill (nothing for family-visible rows). */
export function VisibilityBadge({ value, iconOnly, className }: { value: TxVisibility | undefined; iconOnly?: boolean; className?: string }) {
  if (!value || value === 'family') return null;
  const V = VISIBILITY[value];
  const tone = value === 'private' ? 'bg-warning-soft text-warning-soft-fg' : 'bg-info-soft text-info-soft-fg';
  return (
    <span
      title={iconOnly ? V.label : undefined}
      className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full text-[11px] font-semibold', iconOnly ? 'size-5 justify-center' : 'px-2 py-0.5', tone, className)}
    >
      <V.icon size={iconOnly ? 11 : 10} aria-hidden />
      {iconOnly ? <span className="sr-only">{V.label}</span> : V.label}
    </span>
  );
}

/** "Imported · DBS ••4821" marker. */
export function ImportedTag({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 text-[12px] text-subtle', className)}>
      <Landmark size={12} className="shrink-0" aria-hidden />
      <span className="truncate">Imported · {label}</span>
    </span>
  );
}
