'use client';

import * as ToastP from '@radix-ui/react-toast';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { cn } from '@/lib/cn';

export interface ToastItem {
  id: number;
  title: ReactNode;
  body?: ReactNode;
  tone?: 'success' | 'error' | 'info';
  action?: { label: string; onClick: () => void };
  duration?: number;
  icon?: ReactNode;
}

interface ToastStore {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => number;
  dismiss: (id: number) => void;
}

let next = 1;
export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (t) => {
    const id = next++;
    set((s) => ({ items: [...s.items.slice(-3), { id, ...t }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export const toast = {
  success: (title: ReactNode, body?: ReactNode, extra: Partial<ToastItem> = {}) => useToasts.getState().push({ title, body, tone: 'success', ...extra }),
  error: (title: ReactNode, body?: ReactNode, extra: Partial<ToastItem> = {}) =>
    useToasts.getState().push({ title, body, tone: 'error', duration: 8000, ...extra }),
  info: (title: ReactNode, body?: ReactNode, extra: Partial<ToastItem> = {}) => useToasts.getState().push({ title, body, tone: 'info', ...extra }),
};

export function Toaster({ closeLabel = 'Luk' }: { closeLabel?: string }) {
  const { items, dismiss } = useToasts();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <ToastP.Provider swipeDirection="right">
      {items.map((t) => (
        <ToastP.Root
          key={t.id}
          duration={t.duration ?? 5000}
          onOpenChange={(o) => !o && dismiss(t.id)}
          className="flex w-[360px] max-w-[calc(100vw-32px)] items-start gap-3 rounded-md border border-border bg-surface-raised p-3.5 text-fg shadow-md"
        >
          <span className="mt-0.5">
            {t.icon ??
              (t.tone === 'success' ? (
                <CheckCircle2 className="size-5 text-[var(--color-success)]" />
              ) : t.tone === 'error' ? (
                <XCircle className="size-5 text-accent-fg" />
              ) : (
                <Info className="size-5 text-fg-muted" />
              ))}
          </span>
          <div className="min-w-0 flex-1">
            <ToastP.Title className="text-sm font-medium">{t.title}</ToastP.Title>
            {t.body ? <ToastP.Description className={cn('mt-0.5 text-[13px] text-fg-muted')}>{t.body}</ToastP.Description> : null}
            {t.action ? (
              <ToastP.Action altText={t.action.label} asChild>
                <button type="button" onClick={t.action.onClick} className="mt-2 text-[13px] font-medium text-accent-fg hover:underline">
                  {t.action.label}
                </button>
              </ToastP.Action>
            ) : null}
          </div>
          <ToastP.Close aria-label={closeLabel} className="rounded-sm p-0.5 text-fg-subtle hover:text-fg">
            <X className="size-4" />
          </ToastP.Close>
        </ToastP.Root>
      ))}
      <ToastP.Viewport className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 outline-none" />
    </ToastP.Provider>
  );
}
