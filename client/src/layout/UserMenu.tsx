import { Check, ChevronsUpDown, LogOut, Monitor, Moon, Settings, Sun, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { useTheme, type ThemeMode } from '../lib/theme';
import { Avatar, Menu, type MenuEntry } from '../ui';

const roleLabel = { admin: 'Admin', member: 'Member', child: 'Child' } as const;

/** Sidebar footer: current user + menu (settings, theme, sign out). */
export function UserMenu() {
  const { user, role, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const navigate = useNavigate();
  if (!user) return null;
  const themeItem = (m: ThemeMode, label: string, Icon: typeof Sun): MenuEntry => ({
    label,
    icon: Icon,
    hint: mode === m ? <Check size={15} className="text-primary" /> : undefined,
    onSelect: () => setMode(m),
  });
  return (
    <Menu
      align="start"
      className="w-full"
      menuClassName="min-w-[232px]"
      items={[
        { label: 'Profile & settings', icon: Settings, href: '/settings' },
        { label: 'Family', icon: Users, href: '/family' },
        'divider',
        themeItem('light', 'Light', Sun),
        themeItem('dark', 'Dark', Moon),
        themeItem('system', 'System', Monitor),
        'divider',
        {
          label: 'Sign out',
          icon: LogOut,
          danger: true,
          onSelect: async () => {
            await logout();
            navigate('/login');
          },
        },
      ]}
      trigger={({ open }) => (
        <button
          type="button"
          className={cn('flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-surface-2', open && 'bg-surface-2')}
        >
          <Avatar user={user} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-fg">{user.name}</span>
            <span className="block truncate text-xs text-muted">{role ? roleLabel[role] : user.email}</span>
          </span>
          <ChevronsUpDown size={16} className="shrink-0 text-subtle" />
        </button>
      )}
    />
  );
}
