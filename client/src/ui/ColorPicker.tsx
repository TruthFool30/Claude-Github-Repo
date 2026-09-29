import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

/** Member color palette (see design language). */
export const PALETTE = ['#5B5BD6', '#E5484D', '#F76B15', '#FFB224', '#30A46C', '#12A594', '#0090FF', '#8E4EC6', '#D6409F', '#978365'];

export interface ColorPickerProps {
  value: string | null | undefined;
  onChange: (color: string) => void;
  colors?: string[];
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
}

export function ColorPicker({ value, onChange, colors = PALETTE, size = 'md', className, ...aria }: ColorPickerProps) {
  const dim = size === 'sm' ? 'size-7' : 'size-9';
  return (
    <div role="radiogroup" aria-label={aria['aria-label'] ?? 'Color'} className={cn('flex flex-wrap gap-2.5', className)}>
      {colors.map((c) => {
        const on = value?.toLowerCase() === c.toLowerCase();
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c}
            onClick={() => onChange(c)}
            className={cn(
              dim,
              'flex items-center justify-center rounded-full text-white transition-all duration-150 hover:scale-110 active:scale-95',
              'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
              on && 'ring-2 ring-offset-2 ring-offset-surface',
            )}
            style={{ backgroundColor: c, ['--tw-ring-color' as string]: c }}
          >
            {on && <Check size={size === 'sm' ? 14 : 17} strokeWidth={3} className="animate-check" />}
          </button>
        );
      })}
    </div>
  );
}
