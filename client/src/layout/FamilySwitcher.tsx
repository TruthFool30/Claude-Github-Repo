import { Check, ChevronsUpDown, Plus, Settings2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { Menu, toast, type MenuEntry } from '../ui';
import { errorMessage } from '../lib/api';
import { FamilyAvatar } from './FamilyAvatar';

/** Active family button + dropdown to switch families / create or join another. */
export function FamilySwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { family, families, switchFamily } = useAuth();
  const navigate = useNavigate();

  const items: MenuEntry[] = [
    ...families.map((f) => ({
      label: f.name,
      icon: f.id === family?.id ? <Check size={17} className="text-primary" /> : <FamilyAvatar family={f} size={18} />,
      hint: plural(f.member_count, 'member'),
      onSelect: async () => {
        if (f.id === family?.id) return;
        try {
          await switchFamily(f.id);
          navigate('/home');
          toast.success(`Switched to ${f.name}`);
        } catch (e) {
          toast.error(errorMessage(e));
        }
      },
    })),
    'divider',
    { label: 'Family settings', icon: Settings2, href: '/family' },
    { label: 'Create or join a family', icon: Plus, href: '/onboarding?add=1' },
  ];

  return (
    <Menu
      align="start"
      items={items}
      className={cn('min-w-0', !compact && 'w-full', className)}
      menuClassName="min-w-[240px]"
      trigger={({ open }) => (
        <button
          type="button"
          className={cn(
            'group flex min-w-0 items-center gap-2.5 rounded-xl text-left transition',
            compact ? '-ml-1 p-1 pr-2 hover:bg-surface-2' : 'w-full border border-border bg-surface p-2 shadow-xs hover:border-border-strong',
            open && 'bg-surface-2',
          )}
        >
          <FamilyAvatar family={family} size={compact ? 32 : 36} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold leading-tight text-fg">{family?.name ?? 'Hearth'}</span>
            {!compact && family && <span className="block text-xs text-muted">{plural(family.members.length, 'member')}</span>}
          </span>
          <ChevronsUpDown size={16} className="shrink-0 text-subtle group-hover:text-muted" />
        </button>
      )}
    />
  );
}
