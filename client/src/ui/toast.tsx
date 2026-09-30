import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Info, X, XCircle, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useShell } from '../lib/shell';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';
export interface ToastOptions {
  description?: ReactNode;
  /** ms; default 4000 (errors 6000). 0 = sticky. */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Replace an existing toast with the same id instead of stacking. */
  id?: string;
}
interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
  message: ReactNode;
  leaving?: boolean;
}

let items: ToastItem[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
let seq = 0;

function push(tone: ToastTone, message: ReactNode, opts: ToastOptions = {}) {
  const id = opts.id ?? `t${++seq}`;
  // Empty messages (e.g. errorMessage() of a handled NOT_MEMBER error) are ignored.
  if (message === '' || message === null || message === undefined || message === false) return id;
  const item: ToastItem = { ...opts, id, tone, message };
  items = [...items.filter((t) => t.id !== id), item].slice(-4);
  emit();
  return id;
}

function dismiss(id: string) {
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 180);
}

/**
 * toast.success('Saved'), toast.error(errorMessage(e)), toast.info('Copied', { description }),
 * toast('Plain message'). Returns the toast id; toast.dismiss(id) removes it.
 */
export const toast = Object.assign((message: ReactNode, opts?: ToastOptions) => push('info', message, opts), {
  success: (message: ReactNode, opts?: ToastOptions) => push('success', message, opts),
  error: (message: ReactNode, opts?: ToastOptions) => push('error', message, opts),
  info: (message: ReactNode, opts?: ToastOptions) => push('info', message, opts),
  warning: (message: ReactNode, opts?: ToastOptions) => push('warning', message, opts),
  dismiss,
});

const toneStyles: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'text-success' },
  error: { icon: XCircle, cls: 'text-danger' },
  info: { icon: Info, cls: 'text-primary' },
  warning: { icon: AlertTriangle, cls: 'text-warning' },
};

function ToastCard({ item }: { item: ToastItem }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(item.duration ?? (item.tone === 'error' ? 6000 : 4000));
  useEffect(() => {
    if (paused || remaining.current === 0 || item.leaving) return;
    const start = Date.now();
    const t = setTimeout(() => dismiss(item.id), remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(800, remaining.current - (Date.now() - start));
    };
  }, [paused, item.id, item.leaving]);
  const { icon: Icon, cls } = toneStyles[item.tone];
  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-2xl border border-border bg-surface/95 p-3.5 pr-2.5 shadow-pop backdrop-blur-xl sm:w-[360px]',
        item.leaving ? 'animate-fade-out' : 'animate-toast-in',
      )}
    >
      <Icon size={20} className={cn('mt-px shrink-0', cls)} aria-hidden />
      <div className="min-w-0 flex-1 pt-px">
        <div className="text-sm font-semibold text-fg">{item.message}</div>
        {item.description && <div className="mt-0.5 text-[13px] text-muted">{item.description}</div>}
      </div>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action!.onClick();
            dismiss(item.id);
          }}
          className="shrink-0 rounded-lg px-2.5 py-1 text-sm font-semibold text-primary hover:bg-primary-soft"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(item.id)}
        className="-my-0.5 shrink-0 rounded-lg p-1 text-subtle transition hover:bg-surface-2 hover:text-fg"
      >
        <X size={16} />
      </button>
    </div>
  );
}

/** Mounted once by <UIProvider>. */
export function Toaster() {
  const list = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => items,
    () => items,
  );
  const { toastPlacement } = useShell();
  return createPortal(
    <div
      aria-live="polite"
      data-toaster={toastPlacement}
      className={cn(
        'pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4',
        toastPlacement === 'top'
          ? 'top-[calc(72px+env(safe-area-inset-top))]'
          : 'bottom-[calc(80px+env(safe-area-inset-bottom))] lg:bottom-6 lg:right-6 lg:left-auto lg:items-end lg:px-0',
      )}
    >
      {list.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  );
}
