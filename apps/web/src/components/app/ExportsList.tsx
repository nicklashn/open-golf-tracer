'use client';

import { Download, Film, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { Badge, ProgressBar, Skeleton } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useJobEvents } from '@/lib/events';
import { bytes, duration, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n/client';

interface Row {
  id: string;
  projectId: string | null;
  projectName: string;
  status: string;
  progress: number;
  url: string | null;
  size: number;
  width: number;
  height: number;
  duration: number;
  createdAt: string;
  jobId: string | null;
  settings: { preset: 'shorts' | 'youtube1080' | 'youtube4k' | 'original' };
}

export function ExportsList() {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = useCallback(
    () =>
      api<{ exports: Row[] }>('/exports').then(
        (r) => setRows(r.exports),
        (e) => toast.error(errorMessage(e, t)),
      ),
    [t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useJobEvents((ev) => {
    if (ev.job.kind !== 'export') return;
    if (ev.job.status === 'succeeded' || ev.job.status === 'failed') void load();
    else setRows((rs) => rs?.map((r) => (r.jobId === ev.job.id ? { ...r, status: ev.job.status, progress: ev.job.progress } : r)) ?? rs);
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">{t.exportsPage.title}</h1>
      <p className="mt-1 text-sm text-fg-muted">{t.exportsPage.lead}</p>
      {rows === null ? (
        <div className="mt-8 space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-8 flex flex-col items-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
          <Birdie mood="sleep" size={96} />
          <p className="mt-3 text-sm text-fg-muted">{t.exporter.empty}</p>
          <Button asChild variant="secondary" className="mt-4">
            <Link href="/app">{t.nav.projects}</Link>
          </Button>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-border rounded-lg border border-border bg-surface">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
              <Film className="size-5 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.projectName}</p>
                <p className="tabular text-[12px] text-fg-muted">
                  {t.exporter.presets[r.settings.preset] ?? r.settings.preset}
                  {r.width ? ` · ${r.width}×${r.height}` : ''}
                  {r.duration ? ` · ${duration(r.duration)}` : ''}
                  {r.size ? ` · ${bytes(r.size, locale)}` : ''} · {relativeTime(r.createdAt, locale)}
                </p>
                {r.status === 'queued' || r.status === 'running' ? (
                  <ProgressBar className="mt-2 max-w-xs" value={r.status === 'queued' ? null : r.progress} label={t.jobs.export} />
                ) : null}
              </div>
              <Badge tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'accent' : 'neutral'}>
                {r.status === 'succeeded'
                  ? t.jobs.done
                  : r.status === 'failed'
                    ? t.jobs.failed
                    : r.status === 'canceled'
                      ? t.jobs.canceled
                      : r.status === 'queued'
                        ? t.jobs.queued
                        : t.jobs.export}
              </Badge>
              {r.url ? (
                <Button asChild size="sm" variant="primary">
                  <a href={r.url} download>
                    <Download />
                    {t.exporter.download}
                  </a>
                </Button>
              ) : null}
              <Button
                size="iconSm"
                variant="ghost"
                aria-label={t.common.delete}
                onClick={async () => {
                  if (!confirm(t.exportsPage.deleteConfirm)) return;
                  await api(`/exports/${r.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e, t)));
                  void load();
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
