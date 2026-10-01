import { readableOn } from '../../lib/color';
import { cn } from '../../lib/cn';
import { initials } from '../../lib/format';

interface StackUser {
  id?: number;
  name: string;
  color?: string | null;
  avatar_url?: string | null;
}

/**
 * Compact overlapping avatars that stay legible when small: each circle gets a ring in the
 * surrounding color, a single initial at tiny sizes, and a "+N" chip for the rest.
 */
export function MemberStack({
  users, max = 3, size = 22, ringClass = 'ring-surface', className,
}: {
  users: StackUser[];
  max?: number;
  size?: number;
  /** Ring color matching the background the stack sits on (e.g. 'ring-black/40' on photos). */
  ringClass?: string;
  className?: string;
}) {
  if (!users.length) return null;
  const shown = users.slice(0, users.length > max ? max - 1 : max);
  const rest = users.length - shown.length;
  const font = Math.max(9, Math.round(size * 0.42));
  const label = users.map((u) => u.name).join(', ');
  return (
    <span className={cn('inline-flex items-center', className)} role="img" aria-label={label} title={label}>
      {shown.map((u, i) => {
        const { bg, fg } = readableOn(u.color);
        return (
          <span
            key={u.id ?? u.name}
            className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold ring-2', ringClass)}
            style={{ width: size, height: size, marginLeft: i ? -size * 0.28 : 0, backgroundColor: bg, color: fg, fontSize: font, zIndex: shown.length - i }}
          >
            {u.avatar_url ? <img src={u.avatar_url} alt="" className="size-full object-cover" /> : size < 26 ? initials(u.name).slice(0, 1) : initials(u.name)}
          </span>
        );
      })}
      {rest > 0 && (
        <span
          className={cn('relative inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-bold text-fg ring-2', ringClass)}
          style={{ width: size, height: size, marginLeft: -size * 0.28, fontSize: font }}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}
