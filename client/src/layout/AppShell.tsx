import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { openSearch, setShell, useShell } from '../lib/shell';
import { cn } from '../lib/cn';
import { PageSpinner } from '../ui';
import { BottomNav } from './BottomNav';
import { MoreSheet } from './MoreSheet';
import { useNotificationToasts } from './NotificationBell';
import { SearchPalette } from './SearchPalette';
import { Sidebar } from './Sidebar';
import { DesktopHeader, TopBar } from './TopBar';

/**
 * Authenticated layout. Page content renders inside <main>, which is padded and max-width
 * constrained. For full-height pages (maps, chat) use the CSS variable `--shell-chrome`
 * (total vertical space taken by bars + padding): `h-[calc(100dvh-var(--shell-chrome))]`.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const { hideBottomNav } = useShell();
  useNotificationToasts();

  useEffect(() => {
    window.scrollTo({ top: 0 });
    setShell({ moreOpen: false });
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-dvh">
      <Sidebar />
      <div className="flex min-h-dvh flex-col lg:pl-[264px]">
        <TopBar />
        <DesktopHeader />
        <main
          id="main"
          className={cn(
            'mx-auto w-full max-w-6xl flex-1 px-4 pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-8 lg:[--shell-chrome:calc(64px+32px+48px)]',
            hideBottomNav
              ? 'pb-[calc(16px+env(safe-area-inset-bottom))] [--shell-chrome:calc(56px+env(safe-area-inset-top)+env(safe-area-inset-bottom)+20px+16px)]'
              : 'pb-[calc(96px+env(safe-area-inset-bottom))] [--shell-chrome:calc(56px+64px+env(safe-area-inset-top)+env(safe-area-inset-bottom)+20px+32px)]',
          )}
        >
          <Suspense fallback={<PageSpinner />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <BottomNav />
      <MoreSheet />
      <SearchPalette />
    </div>
  );
}
