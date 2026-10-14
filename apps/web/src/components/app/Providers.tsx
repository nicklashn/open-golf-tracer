'use client';

import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toast';
import { I18nProvider, useI18n } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n';

function ToasterI18n() {
  const { t } = useI18n();
  return <Toaster closeLabel={t.common.close} />;
}

export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <I18nProvider locale={locale}>
      <TooltipProvider delayDuration={350}>
        {children}
        <ToasterI18n />
      </TooltipProvider>
    </I18nProvider>
  );
}
