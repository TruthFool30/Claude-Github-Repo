import { ChevronRight, LogOut, Monitor, Moon, Settings, Sun, Users } from 'lucide-react';
import { NavBadge } from './NavBadge';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { setShell, useShell } from '../lib/shell';
import { useTheme } from '../lib/theme';
import { secondaryModules } from '../modules/registry';
import { Avatar, Modal, SegmentedControl } from '../ui';

/** Mobile "More" sheet: secondary modules, family, settings, theme, sign out. */
export function MoreSheet() {
  const { moreOpen } = useShell();
  const { user, family, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const navigate = useNavigate();
  const close = () => setShell({ moreOpen: false });
  const go = (path: string) => {
    close();
    navigate(path);
  };

  return (
    <Modal open={moreOpen} onClose={close} title="More" size="md">
      <div className="grid grid-cols-3 gap-2.5">
        {secondaryModules.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => go(m.path)}
            className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface-2/50 px-2 py-4 text-center transition active:scale-95 hover:bg-surface-2"
          >
            <span
              className="relative flex size-12 items-center justify-center rounded-2xl text-white shadow-card"
              style={{ background: `linear-gradient(145deg, ${m.accent}, color-mix(in oklab, ${m.accent} 75%, black))` }}
            >
              <m.icon size={22} />
              <NavBadge mod={m} className="absolute -right-1.5 -top-1.5 ring-2 ring-surface" />
            </span>
            <span className="text-[13px] font-semibold leading-tight text-fg">{m.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-border">
        <button type="button" onClick={() => go('/family')} className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-surface-2">
          <span className="flex size-9 items-center justify-center rounded-xl bg-warning-soft text-warning">
            <Users size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-fg">Family</span>
            <span className="block truncate text-xs text-muted">{family?.name}</span>
          </span>
          <ChevronRight size={18} className="text-subtle" />
        </button>
        <div className="h-px bg-border" />
        <button type="button" onClick={() => go('/settings')} className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-surface-2">
          {user ? <Avatar user={user} size="md" /> : <Settings size={18} />}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-fg">Profile & settings</span>
            <span className="block truncate text-xs text-muted">{user?.email}</span>
          </span>
          <ChevronRight size={18} className="text-subtle" />
        </button>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-fg">Appearance</span>
        <SegmentedControl
          size="sm"
          aria-label="Theme"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'system', label: 'Auto', icon: Monitor },
          ]}
        />
      </div>

      <button
        type="button"
        onClick={async () => {
          close();
          await logout();
          navigate('/login');
        }}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-danger transition hover:bg-danger-soft"
      >
        <LogOut size={17} /> Sign out
      </button>
    </Modal>
  );
}
