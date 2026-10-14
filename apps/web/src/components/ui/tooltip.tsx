'use client';

import * as T from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { Kbd } from './misc';

export const TooltipProvider = T.Provider;

export function Tooltip({
  label,
  shortcut,
  children,
  side = 'top',
}: {
  label: ReactNode;
  shortcut?: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <T.Root delayDuration={350}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[60] flex items-center gap-2 rounded-sm bg-gray-950 px-2 py-1 text-xs text-gray-50 shadow-md dark:bg-gray-100 dark:text-gray-950"
        >
          {label}
          {shortcut ? (
            <Kbd className="border-gray-700 bg-gray-800 text-gray-200 dark:border-gray-300 dark:bg-gray-200 dark:text-gray-700">{shortcut}</Kbd>
          ) : null}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
