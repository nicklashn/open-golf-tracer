'use client';

import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t, f } = useI18n();
  const ref = error.digest ?? null;
  return (
    <main id="main" className="flex min-h-screen flex-col items-center justify-center bg-bg px-6 text-center">
      <Birdie mood="confused" size={140} />
      <p className="tabular mt-4 text-sm font-semibold text-accent-fg">500</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-[-0.02em]">{t.serverError.title}</h1>
      <p className="mt-3 max-w-md text-fg-muted">{t.serverError.lead}</p>
      {ref ? <p className="tabular mt-2 text-[13px] text-fg-subtle">{f(t.common.reference, { ref })}</p> : null}
      <Button variant="primary" className="mt-8" onClick={reset}>
        {t.serverError.retry}
      </Button>
    </main>
  );
}
