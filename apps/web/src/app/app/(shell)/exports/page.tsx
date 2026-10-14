import type { Metadata } from 'next';
import { ExportsList } from '@/components/app/ExportsList';
import { getI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t.exportsPage.title };
}

export default function Page() {
  return <ExportsList />;
}
