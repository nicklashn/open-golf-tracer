import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border-strong bg-surface-sunken px-1 font-sans text-[11px] font-medium text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warning';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-surface-sunken text-fg-muted border-border',
    accent: 'bg-red-50 text-red-900 border-red-200 dark:bg-red-900/25 dark:text-red-300 dark:border-red-900/60',
    success:
      'bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-[#067647] border-[color-mix(in_srgb,var(--color-success)_30%,transparent)] dark:text-[#47cd89]',
    warning:
      'bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[#93370d] border-[color-mix(in_srgb,var(--color-warning)_35%,transparent)] dark:text-[#fdb022]',
  };
  return <span className={cn('inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-md border border-border bg-surface', className)} {...props} />;
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-sm bg-surface-sunken', className)} aria-hidden>
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/5" />
    </div>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn('inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  );
}

export function ProgressBar({ value, className, label }: { value: number | null; className?: string; label?: string }) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken', className)}
    >
      {pct == null ? (
        <div className="h-full w-1/3 animate-[shimmer_1.2s_infinite] rounded-full bg-accent" />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn(vertical ? 'w-px self-stretch' : 'h-px w-full', 'bg-border', className)}
    />
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
