import { cn } from '../lib/cn';

/** Hearth app mark: a house with a warm flame, on an indigo→violet tile. */
export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={cn('shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id="hearth-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6E6AF0" />
          <stop offset="1" stopColor="#4B3FC4" />
        </linearGradient>
        <linearGradient id="hearth-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFC56B" />
          <stop offset="1" stopColor="#FF7A45" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#hearth-tile)" />
      <path d="M11 22.5 24 12l13 10.5V35a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2V22.5Z" fill="none" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
      <path d="M24 21c3.2 2.7 5 5.3 5 8.2a5 5 0 0 1-10 0c0-1.7.8-3.2 2-4.3.2 1.4 1 2.3 2 2.6-.6-2.4 0-4.6 1-6.5Z" fill="url(#hearth-flame)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={34} />
      <span className="text-[19px] font-bold tracking-tight text-fg">Hearth</span>
    </div>
  );
}
