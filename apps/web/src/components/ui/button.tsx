import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium select-none transition-colors duration-[120ms] ease-[var(--ease-standard)] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent-hover active:bg-red-800',
        secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-sunken active:bg-border',
        ghost: 'text-fg-muted hover:text-fg hover:bg-surface-sunken',
        danger: 'bg-surface text-accent-fg border border-border-strong hover:bg-red-50 dark:hover:bg-red-900/20',
        link: 'text-accent-fg underline-offset-4 hover:underline px-0 h-auto',
      },
      size: {
        sm: 'h-8 px-3 text-[13px] rounded-sm [&_svg]:size-4',
        md: 'h-10 px-4 text-sm rounded-sm [&_svg]:size-4',
        lg: 'h-12 px-6 text-[15px] rounded-md [&_svg]:size-5',
        icon: 'size-9 rounded-sm [&_svg]:size-[18px]',
        iconSm: 'size-7 rounded-sm [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, loading, children, disabled, ...props },
  ref,
) {
  if (asChild) {
    return (
      <Slot ref={ref} className={cn(button({ variant, size }), className)} {...props}>
        {children}
      </Slot>
    );
  }
  const Comp = 'button';
  return (
    <Comp ref={ref} className={cn(button({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Comp>
  );
});

export { button as buttonVariants };
