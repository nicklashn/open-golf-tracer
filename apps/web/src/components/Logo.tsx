import { cn } from '@/lib/cn';

/** Wordmark: a ball with a tracer arc, and the name. */
export function LogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden focusable="false">
      <path d="M3 27 C 8 12, 16 5, 23.5 8.5" fill="none" stroke="#F04438" strokeWidth="3" strokeLinecap="round" />
      <circle cx="24" cy="10" r="6" fill="#fff" stroke="currentColor" strokeWidth="2" />
      <circle cx="22.4" cy="8.6" r="0.9" fill="#D4D4D8" />
      <circle cx="25.6" cy="8.6" r="0.9" fill="#D4D4D8" />
      <circle cx="24" cy="11.6" r="0.9" fill="#D4D4D8" />
    </svg>
  );
}

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-fg', className)}>
      <LogoMark />
      {withText ? <span className="text-[17px] font-semibold tracking-[-0.02em]">open golf tracer</span> : null}
    </span>
  );
}
