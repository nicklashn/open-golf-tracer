import Link from 'next/link';
import { Birdie } from '@/components/mascot/Birdie';
import { buttonVariants } from '@/components/ui/button';
import { getI18n } from '@/lib/i18n/server';
import { cn } from '@/lib/cn';

export default async function NotFound() {
  const { t } = await getI18n();
  return (
    <main id="main" className="flex min-h-screen flex-col items-center justify-center bg-bg px-6 text-center">
      <Birdie mood="confused" size={140} />
      <p className="tabular mt-4 text-sm font-semibold text-accent-fg">404</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-[-0.02em]">{t.notFound.title}</h1>
      <p className="mt-3 max-w-md text-fg-muted">{t.notFound.lead}</p>
      <div className="mt-8 flex gap-3">
        <Link href="/app" className={cn(buttonVariants({ variant: 'primary' }))}>
          {t.notFound.projects}
        </Link>
      </div>
    </main>
  );
}
