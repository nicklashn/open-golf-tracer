'use client';

import * as P from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({
  children,
  className,
  side,
  align = 'start',
}: {
  children: ReactNode;
  className?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'end' | 'center';
}) {
  return (
    <P.Portal>
      <P.Content
        side={side}
        align={align}
        sideOffset={6}
        className={cn('z-50 rounded-md border border-border bg-surface-raised p-3 text-sm text-fg shadow-md focus:outline-none', className)}
      >
        {children}
      </P.Content>
    </P.Portal>
  );
}
