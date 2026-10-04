// Member chips for assigning people. Local to the lists module: the selected state is a colored
// ring + tinted chip + trailing check, so nothing covers the avatar's initials.
import { Check } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName } from '../../lib/format';
import type { Member } from '../../lib/types';
import { Avatar } from '../../ui';

export interface PeoplePickerProps {
  value: number | null;
  onChange: (id: number | null) => void;
  /** Allow clicking the selected chip again to clear (default true). */
  allowEmpty?: boolean;
  filter?: (m: Member) => boolean;
  disabled?: boolean;
  /** Single row (scroll horizontally in a parent). */
  nowrap?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function PeoplePicker({ value, onChange, allowEmpty = true, filter, disabled, nowrap, className, ...aria }: PeoplePickerProps) {
  const { members } = useAuth();
  const list = filter ? members.filter(filter) : members;
  return (
    <div role="radiogroup" aria-label={aria['aria-label'] ?? 'Family members'} className={cn('flex gap-2', nowrap ? 'flex-nowrap' : 'flex-wrap', className)}>
      {list.map((m) => {
        const on = m.id === value;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(on ? (allowEmpty ? null : m.id) : m.id)}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-full border py-1 pl-1 text-[13px] font-medium transition-all duration-150 active:scale-95 disabled:pointer-events-none',
              on ? 'pr-2 text-fg' : 'border-border bg-surface pr-3 text-muted hover:border-border-strong hover:text-fg',
            )}
            style={on ? { borderColor: m.color, backgroundColor: `color-mix(in oklab, ${m.color} 14%, var(--surface))` } : undefined}
          >
            <span className="rounded-full" style={on ? { boxShadow: `0 0 0 2px var(--surface), 0 0 0 3.5px ${m.color}` } : undefined}>
              <Avatar user={m} size="sm" title="" />
            </span>
            {m.nickname || firstName(m.name)}
            {on && <Check size={14} strokeWidth={3} className="animate-check" style={{ color: `color-mix(in oklab, ${m.color} 70%, var(--fg))` }} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
