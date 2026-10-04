import { Check } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { firstName } from '../lib/format';
import type { Member } from '../lib/types';
import { Avatar } from './Avatar';
import { readableOn } from '../lib/color';

interface BaseProps {
  /** Defaults to the active family's members. */
  members?: Member[];
  /** Hide managed/child members, etc. */
  filter?: (m: Member) => boolean;
  size?: 'sm' | 'md';
  className?: string;
  /** Show an "Everyone" chip (multiple mode) that selects/clears all. */
  showAll?: boolean;
  'aria-label'?: string;
}
export interface MemberPickerMultiProps extends BaseProps {
  multiple: true;
  value: number[];
  onChange: (ids: number[]) => void;
}
export interface MemberPickerSingleProps extends BaseProps {
  multiple?: false;
  value: number | null;
  onChange: (id: number | null) => void;
  /** Allow deselecting (value becomes null). Default true. */
  allowEmpty?: boolean;
}
export type MemberPickerProps = MemberPickerMultiProps | MemberPickerSingleProps;

/**
 * Chip row of family members (avatar + first name) for assigning people.
 *   <MemberPicker multiple value={ids} onChange={setIds} />
 *   <MemberPicker value={userId} onChange={setUserId} />
 */
export function MemberPicker(props: MemberPickerProps) {
  const auth = useAuth();
  const list = (props.members ?? auth.members).filter(props.filter ?? (() => true));
  const selected = new Set(props.multiple ? props.value : props.value != null ? [props.value] : []);
  const allSelected = props.multiple && list.length > 0 && list.every((m) => selected.has(m.id));

  const toggle = (id: number) => {
    if (props.multiple) {
      props.onChange(selected.has(id) ? props.value.filter((v) => v !== id) : [...props.value, id]);
    } else {
      const allowEmpty = props.allowEmpty ?? true;
      props.onChange(selected.has(id) ? (allowEmpty ? null : id) : id);
    }
  };

  const chip = 'inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[13px] font-medium transition-all duration-150 active:scale-95';
  return (
    <div role="group" aria-label={props['aria-label'] ?? 'Family members'} className={cn('flex flex-wrap gap-2', props.className)}>
      {props.multiple && props.showAll && (
        <button
          type="button"
          aria-pressed={allSelected}
          onClick={() => props.onChange(allSelected ? [] : list.map((m) => m.id))}
          className={cn(
            chip,
            'pl-3',
            allSelected ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-border bg-surface text-muted hover:border-border-strong',
          )}
        >
          Everyone
        </button>
      )}
      {list.map((m) => {
        const on = selected.has(m.id);
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(m.id)}
            className={cn(chip, on ? 'text-fg' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-fg')}
            style={on ? { borderColor: m.color, backgroundColor: `color-mix(in oklab, ${m.color} 14%, var(--surface))` } : undefined}
          >
            <span className="relative">
              <Avatar user={m} size={props.size === 'md' ? 'md' : 'sm'} title="" />
              {on && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full ring-2 ring-surface animate-check"
                  style={{ backgroundColor: readableOn(m.color).bg, color: readableOn(m.color).fg }}
                >
                  <Check size={9} strokeWidth={4} />
                </span>
              )}
            </span>
            {m.nickname || firstName(m.name)}
          </button>
        );
      })}
    </div>
  );
}
