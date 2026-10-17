/** Mounting editor components in happy-dom with render counting (React.Profiler). */
import { Profiler, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { I18nProvider } from '@/lib/i18n/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Counter {
  commits: Record<string, number>;
  ms: Record<string, number>;
  reset(): void;
}

export function counter(): Counter {
  const c: Counter = {
    commits: {},
    ms: {},
    reset() {
      c.commits = {};
      c.ms = {};
    },
  };
  return c;
}

export function Count({ id, c, children }: { id: string; c: Counter; children: ReactNode }) {
  return (
    <Profiler
      id={id}
      onRender={(pid, _phase, actual) => {
        c.commits[pid] = (c.commits[pid] ?? 0) + 1;
        c.ms[pid] = (c.ms[pid] ?? 0) + actual;
      }}
    >
      {children}
    </Profiler>
  );
}

export function mount(node: ReactNode): { root: Root; el: HTMLElement; unmount: () => void } {
  const el = document.createElement('div');
  el.style.width = '1400px';
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(
      <I18nProvider locale="en">
        <TooltipProvider>{node}</TooltipProvider>
      </I18nProvider>,
    );
  });
  return {
    root,
    el,
    unmount: () => {
      act(() => root.unmount());
      el.remove();
    },
  };
}
