/**
 * Let a page swallow the live notification toast for something the user is already looking at
 * (e.g. a comment on the photo that's open in the viewer). The notification still lands in the
 * bell; only the pop-up toast is skipped.
 */
import { useEffect, useRef } from 'react';

export type NotificationLike = { module?: string | null; link?: string | null; title: string };
type Filter = (n: NotificationLike) => boolean;

const filters = new Set<Filter>();

/** True when some mounted page asked to suppress this notification's toast. */
export function isToastSuppressed(n: NotificationLike): boolean {
  for (const f of filters) {
    try {
      if (f(n)) return true;
    } catch {
      /* a broken filter never blocks toasts */
    }
  }
  return false;
}

/** While mounted, skip toasts for notifications where `predicate(n)` is true. */
export function useSuppressNotificationToast(predicate: Filter | null) {
  const ref = useRef(predicate);
  ref.current = predicate;
  useEffect(() => {
    const f: Filter = (n) => !!ref.current?.(n);
    filters.add(f);
    return () => {
      filters.delete(f);
    };
  }, []);
}
