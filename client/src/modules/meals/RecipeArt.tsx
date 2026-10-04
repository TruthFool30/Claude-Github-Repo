import { useState } from 'react';
import type { AvatarUser } from '../../lib/types';
import { Avatar } from '../../ui';
import { Heart } from 'lucide-react';
import { cn } from '../../lib/cn';
import { recipeIcon } from './utils';

interface ArtProps {
  recipe: { title: string; photo_url: string | null; icon: string; color: string };
  className?: string;
  iconSize?: number;
  rounded?: string;
}

/** Recipe photo, or a soft gradient tile with the recipe's icon when there is none. */
export function RecipeArt({ recipe, className, iconSize = 40, rounded = 'rounded-2xl' }: ArtProps) {
  const [failed, setFailed] = useState(false);
  const Icon = recipeIcon(recipe.icon);
  const c = recipe.color || '#F76B15';
  if (recipe.photo_url && !failed) {
    return (
      <div className={cn('relative overflow-hidden bg-surface-2', rounded, className)}>
        <img src={recipe.photo_url} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className={cn('relative flex items-center justify-center overflow-hidden', rounded, className)}
      style={{
        background: `radial-gradient(120% 90% at 20% 10%, color-mix(in oklab, ${c} 45%, white) 0%, transparent 55%), radial-gradient(90% 80% at 90% 100%, color-mix(in oklab, ${c} 70%, black) 0%, transparent 60%), linear-gradient(140deg, color-mix(in oklab, ${c} 78%, white) 0%, ${c} 55%, color-mix(in oklab, ${c} 82%, black) 100%)`,
        color: '#fff',
      }}
    >
      <span className="absolute -right-[12%] -top-[18%] aspect-square w-[55%] rounded-full bg-white/20" />
      <span className="absolute -bottom-[22%] -left-[10%] aspect-square w-[45%] rounded-full bg-white/10" />
      <span className="absolute bottom-[14%] right-[16%] aspect-square w-[9%] rounded-full bg-white/35" />
      <span className="absolute left-[18%] top-[20%] aspect-square w-[5%] rounded-full bg-white/40" />
      <Icon size={iconSize} strokeWidth={1.7} className="relative drop-shadow-[0_2px_6px_rgb(0_0_0/0.25)]" />
    </div>
  );
}

/** Round heart button for favorites (used on cards and the detail hero). */
export function FavoriteButton({
  active, onToggle, size = 'md', className, visualClassName, title,
}: { active: boolean; onToggle: () => void; size?: 'sm' | 'md'; className?: string; visualClassName?: string; title: string }) {
  // The visible circle is 32/40px, but the button itself is always a 44×44 touch target.
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={cn('group/fav inline-flex size-11 items-center justify-center rounded-full focus-visible:outline-none', className)}
    >
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full bg-white/90 text-[#1a1b26] shadow-card backdrop-blur transition group-hover/fav:scale-110 group-active/fav:scale-90 group-focus-visible/fav:ring-4 group-focus-visible/fav:ring-ring dark:bg-black/55 dark:text-white',
          size === 'sm' ? 'size-8' : 'size-10',
          visualClassName,
        )}
      >
        <Heart size={size === 'sm' ? 16 : 19} className={cn('transition', active && 'animate-check fill-[#E5484D] text-[#E5484D]')} />
      </span>
    </button>
  );
}

/** Overlapping member avatars, each ringed in the surface color so they read as separate people. */
export function MemberStack({ users, max = 4 }: { users: AvatarUser[]; max?: number }) {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 pl-0.5" aria-label={users.map((u) => u.name).join(', ')}>
      {shown.map((u, i) => (
        <span key={`${u.name}-${i}`} className="inline-flex rounded-full ring-2 ring-surface">
          <Avatar user={u} size="xs" />
        </span>
      ))}
      {extra > 0 && (
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-surface-3 px-1 text-[10px] font-bold text-muted ring-2 ring-surface">+{extra}</span>
      )}
    </span>
  );
}
