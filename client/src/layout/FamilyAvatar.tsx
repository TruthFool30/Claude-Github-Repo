import { cn } from '../lib/cn';
import { initials } from '../lib/format';

/** Square tile for a family: cover photo or initials on the brand gradient. */
export function FamilyAvatar({ family, size = 36, className }: { family: { name: string; cover_url?: string | null } | null; size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden font-bold text-white', className)}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        fontSize: size * 0.36,
        background: family?.cover_url ? undefined : 'linear-gradient(145deg, #F7A84A, #E5484D)',
      }}
    >
      {family?.cover_url ? <img src={family.cover_url} alt="" className="size-full object-cover" /> : initials(family?.name)}
    </span>
  );
}
