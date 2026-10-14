'use client';

import { Film, FolderOpen, Monitor, Moon, Settings, SlidersHorizontal, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import { useTheme } from './AppRoot';

export function AppShell({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const { pref, setPref } = useTheme();
  const pathname = usePathname();
  const router = useRouter();

  const nav = [
    { href: '/app', label: t.nav.projects, icon: FolderOpen, exact: true },
    { href: '/app/exports', label: t.nav.exports, icon: Film },
    { href: '/app/settings', label: t.nav.settings, icon: Settings },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2"
        >
          {t.nav.skipToContent}
        </a>
        <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-4 sm:px-6">
          <Link href="/app" className="rounded-sm" aria-label={t.nav.projects}>
            <Logo />
          </Link>
          <nav aria-label={t.common.menu} className="hidden items-center gap-1 sm:flex">
            {nav.map((n) => {
              const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('rounded-sm px-3 py-1.5 text-sm font-medium text-fg-muted hover:text-fg', active && 'bg-surface-sunken text-fg')}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Menu>
              <MenuTrigger asChild>
                <button
                  type="button"
                  className="flex size-9 items-center justify-center rounded-full bg-surface-sunken text-fg ring-1 ring-border hover:ring-border-strong"
                  aria-label={t.nav.preferences}
                >
                  <SlidersHorizontal className="size-4" aria-hidden />
                </button>
              </MenuTrigger>
              <MenuContent className="w-64">
                <div className="sm:hidden">
                  {nav.map((n) => (
                    <MenuItem key={n.href} icon={<n.icon />} onSelect={() => router.push(n.href)}>
                      {n.label}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                </div>
                <MenuLabel>{t.common.theme}</MenuLabel>
                <MenuItem icon={<Sun />} onSelect={() => setPref('light')}>
                  {t.common.themeLight} {pref === 'light' ? '✓' : ''}
                </MenuItem>
                <MenuItem icon={<Moon />} onSelect={() => setPref('dark')}>
                  {t.common.themeDark} {pref === 'dark' ? '✓' : ''}
                </MenuItem>
                <MenuItem icon={<Monitor />} onSelect={() => setPref('system')}>
                  {t.common.themeSystem} {pref === 'system' ? '✓' : ''}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  onSelect={() => {
                    const l = locale === 'da' ? 'en' : 'da';
                    setLocale(l);
                    void api('/account', { method: 'PATCH', body: { locale: l } }).catch(() => undefined);
                  }}
                >
                  {t.common.language}: {locale === 'da' ? 'English' : 'Dansk'}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}
