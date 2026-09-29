import { cn } from '../lib/cn';

export interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

/** Circular loading indicator; inherits text color. */
export function Spinner({ size = 18, className, label = 'Loading' }: SpinnerProps) {
  return (
    <svg
      role="status"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('animate-spin', className)}
    >
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Centered spinner for page/section loading. */
export function PageSpinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex min-h-[40vh] items-center justify-center text-primary', className)}>
      <Spinner size={28} />
    </div>
  );
}
