import { Search, WifiOff } from 'lucide-react';
import { useLiveStatus } from '../lib/live';
import { useIsDesktop } from '../lib/hooks';
import { openSearch } from '../lib/shell';
import { IconButton } from '../ui';
import { FamilySwitcher } from './FamilySwitcher';
import { NotificationBell } from './NotificationBell';

function LiveIndicator() {
  const status = useLiveStatus();
  if (status !== 'reconnecting') return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning-soft-fg" role="status">
      <WifiOff size={13} /> Reconnecting…
    </span>
  );
}

/** Mobile top bar (<1024px): family switcher, search, notifications. */
export function TopBar() {
  const isDesktop = useIsDesktop();
  return (
    <header className="pt-safe sticky top-0 z-30 border-b border-border/70 bg-bg/80 backdrop-blur-xl backdrop-saturate-150 lg:hidden">
      <div className="flex h-14 items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          <FamilySwitcher compact />
        </div>
        <LiveIndicator />
        <IconButton icon={Search} label="Search" onClick={openSearch} />
        {!isDesktop && <NotificationBell />}
      </div>
    </header>
  );
}

/** Desktop header above page content: search field + notifications. */
export function DesktopHeader() {
  const isDesktop = useIsDesktop();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header className="sticky top-0 z-20 hidden h-16 items-center gap-3 border-b border-border/60 bg-bg/80 px-10 backdrop-blur-xl lg:flex">
      <button
        type="button"
        onClick={openSearch}
        className="flex h-10 w-full max-w-md items-center gap-3 rounded-xl border border-border bg-surface px-3.5 text-left text-sm text-subtle shadow-xs transition hover:border-border-strong"
      >
        <Search size={17} />
        <span className="flex-1">Search Hearth…</span>
        <kbd className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-muted">
          {mac ? '⌘' : 'Ctrl'} K
        </kbd>
      </button>
      <div className="flex-1" />
      <LiveIndicator />
      {isDesktop && <NotificationBell />}
    </header>
  );
}
