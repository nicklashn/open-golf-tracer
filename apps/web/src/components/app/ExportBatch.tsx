'use client';

/**
 * Exports outside the editor: the ones still running (they go on when the editor is closed), and
 * "Export all" for the videos one "Make a video for me" made (a short per shot) – queued in one go
 * with one preset, downloadable together as a zip from My videos.
 */
import { Film } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ExportPreset } from '@golf/schema';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { ProgressBar } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useJobEvents } from '@/lib/events';
import { useI18n } from '@/lib/i18n/client';

export interface ExportInfo {
  id: string;
  projectId: string | null;
  projectName: string;
  status: string;
  progress: number;
  jobId: string | null;
  settings: { preset: ExportPreset; batch?: string };
}

const active = (e: { status: string }) => e.status === 'queued' || e.status === 'running';

/** The exports still queued or running, with their progress; nothing when there are none. */
export function RunningExports() {
  const { t, f } = useI18n();
  const [rows, setRows] = useState<ExportInfo[]>([]);
  const load = useCallback(
    () =>
      api<{ exports: ExportInfo[] }>('/exports').then(
        (r) => setRows(r.exports.filter(active)),
        () => undefined,
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useJobEvents((ev) => {
    if (ev.job.kind !== 'export') return;
    const known = rows.some((r) => r.jobId === ev.job.id);
    if (!known || !active(ev.job)) void load();
    else setRows((rs) => rs.map((r) => (r.jobId === ev.job.id ? { ...r, status: ev.job.status, progress: ev.job.progress } : r)));
  });
  if (!rows.length) return null;
  return (
    <section className="mt-6 rounded-lg border border-border bg-surface p-4" aria-label={t.projects.running} data-testid="running-exports">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t.projects.running} ({rows.length})
        </h2>
        <Link href="/app/exports" className="text-[13px] font-medium text-accent-fg underline-offset-4 hover:underline">
          {t.exporter.allVideos}
        </Link>
      </div>
      <p className="text-[12px] text-fg-muted">{t.projects.runningLead}</p>
      <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
        {rows.slice(0, 8).map((r) => (
          <li key={r.id} className="flex items-center gap-3 text-[13px]">
            <Film className="size-4 shrink-0 text-fg-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate">
                {r.projectName} · <span className="text-fg-muted">{t.exporter.presets[r.settings.preset] ?? r.settings.preset}</span>
              </p>
              <ProgressBar
                className="mt-1"
                value={r.status === 'queued' ? null : r.progress}
                label={r.status === 'queued' ? t.exporter.queued : f(t.exporter.running, { pct: Math.round(r.progress * 100) })}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PRESETS: ExportPreset[] = ['shorts', 'youtube1080', 'youtube4k', 'original'];

/** One preset for all the videos of one "Make a video for me". */
export function ExportAllDialog({
  open,
  onOpenChange,
  projectIds,
  vertical,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectIds: string[];
  vertical: boolean;
}) {
  const { t, f } = useI18n();
  const [preset, setPreset] = useState<ExportPreset>(vertical ? 'shorts' : 'youtube1080');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPreset(vertical ? 'shorts' : 'youtube1080');
  }, [open, vertical]);
  async function start() {
    setBusy(true);
    try {
      const r = await api<{ batch: string; exports: unknown[] }>('/exports/batch', { body: { projectIds, settings: { preset } } });
      toast.success(f(t.projects.exportAllStarted, { n: r.exports.length }), t.projects.runningLead);
      onOpenChange(false);
    } catch (e) {
      toast.error(t.exporter.failed, errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={f(t.projects.exportAllTitle, { n: projectIds.length })} description={t.projects.exportAllLead} closeLabel={t.common.close}>
        <div role="radiogroup" aria-label={t.exporter.preset} className="grid grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={preset === p}
              onClick={() => setPreset(p)}
              className="rounded-md border border-border p-3 text-left hover:border-border-strong aria-checked:border-red-500 aria-checked:bg-red-500/10"
            >
              <span className="block text-sm font-medium">{t.exporter.presets[p]}</span>
              <span className="block text-[12px] text-fg-muted">{t.exporter.presetDetail[p]}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" loading={busy} onClick={start} data-testid="export-all-start">
            {f(t.projects.exportAll, { n: projectIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
