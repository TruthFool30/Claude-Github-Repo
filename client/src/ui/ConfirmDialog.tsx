import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Modal';
import { cn } from '../lib/cn';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + warning icon. */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Controlled confirmation dialog. Prefer `useConfirm()` for one-off confirmations. */
export function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, loading, onConfirm, onCancel,
}: ConfirmDialogProps) {
  const Icon = danger ? AlertTriangle : HelpCircle;
  return (
    <Modal open={open} onClose={onCancel} size="sm" hideClose dismissible={!loading}>
      <div className="flex flex-col items-center pt-4 text-center sm:pt-2">
        <div
          className={cn(
            'mb-4 flex size-14 items-center justify-center rounded-2xl',
            danger ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary',
          )}
        >
          <Icon size={26} />
        </div>
        <h2 className="text-lg font-bold tracking-tight text-fg">{title}</h2>
        {message && <div className="mt-1.5 text-sm leading-relaxed text-muted">{message}</div>}
        <div className="mt-6 flex w-full flex-col-reverse gap-2 sm:flex-row">
          <Button variant="secondary" block onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} block onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}
let pending: Pending | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

/** Imperative confirm usable outside React: `if (await confirmDialog({ title: 'Delete?' })) …` */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { ...opts, resolve };
    emit();
  });
}

/**
 * const confirm = useConfirm();
 * if (await confirm({ title: 'Delete list?', message: 'This cannot be undone.', danger: true, confirmLabel: 'Delete' })) { … }
 */
export function useConfirm() {
  return confirmDialog;
}

/** Mounted once by <UIProvider>. */
export function ConfirmHost() {
  const current = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => pending,
    () => pending,
  );
  const [last, setLast] = useState<Pending | null>(null);
  if (current && current !== last) setLast(current);
  const shown = current ?? last;
  const close = (ok: boolean) => {
    current?.resolve(ok);
    pending = null;
    emit();
  };
  return (
    <ConfirmDialog
      open={!!current}
      title={shown?.title ?? ''}
      message={shown?.message}
      confirmLabel={shown?.confirmLabel}
      cancelLabel={shown?.cancelLabel}
      danger={shown?.danger}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );
}
