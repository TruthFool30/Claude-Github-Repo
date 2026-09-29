import { useState } from 'react';
import { cn } from '../lib/cn';
import { initials } from '../lib/format';
import type { AvatarUser } from '../lib/types';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const px: Record<AvatarSize, number> = { xs: 20, sm: 28, md: 36, lg: 48, xl: 72, '2xl': 104 };
const text: Record<AvatarSize, string> = {
  xs: 'text-[9px]', sm: 'text-[11px]', md: 'text-[13px]', lg: 'text-base', xl: 'text-2xl', '2xl': 'text-[34px]',
};

export interface AvatarProps {
  user: AvatarUser | null | undefined;
  size?: AvatarSize;
  /** Ring in the member's color (e.g. selected state). */
  ring?: boolean;
  /** Show a small status dot (e.g. online / checked-in). */
  status?: 'online' | 'away' | null;
  className?: string;
  title?: string;
}

/** Member avatar: photo if available, otherwise initials on the member's color. */
export function Avatar({ user, size = 'md', ring, status, className, title }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const dim = px[size];
  const color = user?.color || '#8d90a0';
  const src = user?.avatar_url && failed !== user.avatar_url ? user.avatar_url : null;
  return (
    <span
      className={cn('relative inline-flex shrink-0 select-none', className)}
      style={{ width: dim, height: dim }}
      title={title ?? user?.name}
    >
      <span
        className={cn(
          'flex size-full items-center justify-center overflow-hidden rounded-full font-semibold text-white',
          text[size],
          ring && 'ring-2 ring-offset-2 ring-offset-surface',
        )}
        style={{
          background: src ? undefined : `linear-gradient(145deg, ${color}, color-mix(in oklab, ${color} 78%, black))`,
          ['--tw-ring-color' as string]: color,
        }}
      >
        {src ? (
          <img src={src} alt="" className="size-full object-cover" onError={() => setFailed(src)} draggable={false} />
        ) : (
          <span aria-hidden className="tracking-wide">{initials(user?.name)}</span>
        )}
      </span>
      {status && (
        <span
          className={cn(
            'absolute bottom-0 right-0 rounded-full ring-2 ring-surface',
            status === 'online' ? 'bg-success' : 'bg-warning',
            dim >= 48 ? 'size-3.5' : 'size-2.5',
          )}
        />
      )}
    </span>
  );
}

export interface AvatarStackProps {
  users: AvatarUser[];
  max?: number;
  size?: AvatarSize;
  className?: string;
}

/** Overlapping avatars with a "+N" chip. */
export function AvatarStack({ users, max = 4, size = 'sm', className }: AvatarStackProps) {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  const dim = px[size];
  return (
    <div className={cn('flex items-center', className)} title={users.map((u) => u.name).join(', ')}>
      {shown.map((u, i) => (
        <span key={`${u.name}-${i}`} className="rounded-full ring-2 ring-surface" style={{ marginLeft: i ? -dim * 0.3 : 0 }}>
          <Avatar user={u} size={size} title="" />
        </span>
      ))}
      {extra > 0 && (
        <span
          className={cn('flex items-center justify-center rounded-full bg-surface-3 font-semibold text-muted ring-2 ring-surface', text[size])}
          style={{ width: dim, height: dim, marginLeft: -dim * 0.3 }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
