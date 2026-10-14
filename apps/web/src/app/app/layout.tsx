import { cookies } from 'next/headers';
import { THEME_COOKIE, readThemeCookie } from '@/lib/theme';
import { AppRoot } from '@/components/app/AppRoot';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const pref = readThemeCookie((await cookies()).get(THEME_COOKIE)?.value);
  return <AppRoot themePref={pref}>{children}</AppRoot>;
}
