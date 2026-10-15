'use client';

import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/client';
import { useMe, type Me } from '@/lib/me';
import { AiSettingsForm } from './AiSettings';
import { useTheme } from './AppRoot';

function Section({ id, title, children, lead }: { id?: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-b border-border py-8 first:pt-0" aria-labelledby={`${id}-h`}>
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div>
          <h2 id={`${id}-h`} className="text-base font-semibold">
            {title}
          </h2>
          {lead ? <p className="mt-1 text-[13px] text-fg-muted">{lead}</p> : null}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { me, set: setMe } = useMe();
  const { pref, setPref } = useTheme();

  if (!me) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-8 text-2xl font-semibold tracking-[-0.02em]">{t.settings.title}</h1>

      <Section id="preferences" title={t.settings.preferences}>
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{t.common.language}</p>
            <Segmented
              label={t.common.language}
              value={locale}
              onChange={(l) => {
                setLocale(l);
                void api('/account', { method: 'PATCH', body: { locale: l } }).catch(() => undefined);
              }}
              options={[
                { value: 'da', label: 'Dansk' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{t.common.units}</p>
            <Segmented
              label={t.common.units}
              value={me.units}
              onChange={(u) => void api<{ user: Me }>('/account', { method: 'PATCH', body: { units: u } }).then((r) => setMe(r.user))}
              options={[
                { value: 'm', label: t.common.metres },
                { value: 'yd', label: t.common.yards },
              ]}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{t.common.theme}</p>
            <Segmented
              label={t.common.theme}
              value={pref}
              onChange={setPref}
              options={[
                { value: 'light', label: t.common.themeLight },
                { value: 'dark', label: t.common.themeDark },
                { value: 'system', label: t.common.themeSystem },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section id="ai" title={t.ai.title} lead={t.ai.lead}>
        <AiSettingsForm />
      </Section>

      <Section id="data" title={t.settings.data} lead={t.settings.exportDataLead}>
        <Button asChild variant="secondary">
          <a href="/api/account/export" download>
            <Download />
            {t.settings.exportData}
          </a>
        </Button>
      </Section>
    </div>
  );
}
