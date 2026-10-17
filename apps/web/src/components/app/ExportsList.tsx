'use client';

import { Check, Copy, Download, Film, Play, Trash2 } from 'lucide-react';
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
  previewUrl?: string | null;
  size: number;
  width: number;
  height: number;
  duration: number;
  createdAt: string;
  jobId: string | null;
  /** `publishText`: the made video's description and chapters, as exported. */
  settings: { preset: 'shorts' | 'youtube1080' | 'youtube4k' | 'original'; publishText?: string };
}

export function ExportsList() {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
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
        <div
          className="mt-8 flex flex-col items-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center"
          data-testid="exports-empty"
        >
          <Birdie mood="sleep" size={96} />
          <h2 className="mt-3 text-base font-semibold">{t.exporter.empty}</h2>
          <p className="mt-1 max-w-md text-sm text-fg-muted">{t.exporter.emptyLead}</p>
          <Button asChild variant="secondary" className="mt-4">
            <Link href="/app">{t.exporter.toProjects}</Link>
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
              {r.previewUrl ? (
                <Button asChild size="sm" variant="ghost">
                  <a href={r.previewUrl} target="_blank" rel="noreferrer" aria-label={`${t.exporter.play}: ${r.projectName}`}>
                    <Play />
                    {t.exporter.play}
                  </a>
                </Button>
              ) : null}
              {r.settings.publishText ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="copy-youtube"
                  title={t.youtube.hint}
                  onClick={() => {
                    void navigator.clipboard?.writeText(r.settings.publishText ?? '').catch(() => {});
                    setCopied(r.id);
                  }}
                >
                  {copied === r.id ? <Check /> : <Copy />}
                  {copied === r.id ? t.youtube.copied : t.youtube.copy}
                </Button>
              ) : null}
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
