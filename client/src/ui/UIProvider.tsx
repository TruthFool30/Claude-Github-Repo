import type { ReactNode } from 'react';
import { ConfirmHost } from './ConfirmDialog';
import { Toaster } from './toast';

/** Mounts global UI hosts (toasts, confirm dialog). Rendered once in App. */
export function UIProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
      <ConfirmHost />
    </>
  );
}
