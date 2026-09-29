import { useEffect, useState, useSyncExternalStore } from 'react';

/** Reactive media query. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** true at >= 1024px (sidebar layout). */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');

/** Debounced copy of a value. */
export function useDebounce<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Set document.title as "<title> · Hearth". */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Hearth` : 'Hearth';
  }, [title]);
}
