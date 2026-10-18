'use client';

import { Check, Copy, Download, Film, FolderOpen, Pencil, Play, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
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
  errorCode?: string;
  /** `publishText`: the made video's description and chapters, as exported. */
  settings: { preset: 'shorts' | 'youtube1080' | 'youtube4k' | 'original'; batch?: string; publishText?: string };
}

/** Rows in order, those exported together ("Export all") under one heading. */
type Item = { kind: 'row'; row: Row } | { kind: 'batch'; batch: string; rows: Row[] };

export function groupExports(rows: Row[]): Item[] {
  const items: Item[] = [];
  const batches = new Map<string, Extract<Item, { kind: 'batch' }>>();
  for (const row of rows) {
    const b = row.settings.batch;
    if (!b) {
      items.push({ kind: 'row', row });
      continue;
    }
    let item = batches.get(b);
    if (!item) {
      item = { kind: 'batch', batch: b, rows: [] };
      batches.set(b, item);
      items.push(item);
    }
    item.rows.push(row);
  }
  return items;
}

export function ExportsList() {
  const { t, f } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  // The projects the videos came from (for the thumbnail and the way back), by id.
  const [projects, setProjects] = useState<Record<string, { posterUrl: string | null }>>({});
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
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
    api<{ projects: { id: string; posterUrl: string | null }[] }>('/projects').then(
      (r) => setProjects(Object.fromEntries(r.projects.map((p) => [p.id, p]))),
      () => undefined,
    );
  }, [load]);
  useJobEvents((ev) => {
    if (ev.job.kind !== 'export') return;
    const known = rows?.some((r) => r.jobId === ev.job.id);
    // A new export (started in the editor or by "Export all") joins the list.
    if (!known || ev.job.status === 'succeeded' || ev.job.status === 'failed') void load();
    else setRows((rs) => rs?.map((r) => (r.jobId === ev.job.id ? { ...r, status: ev.job.status, progress: ev.job.progress } : r)) ?? rs);
  });
  const items = useMemo(() => (rows ? groupExports(rows) : []), [rows]);

  async function openFolder(exportId?: string) {
    try {
      await api('/exports/open-folder', { body: { exportId: exportId ?? null } });
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }

  async function doDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/exports/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      void load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  const row = (r: Row) => (
    <ExportRow
      key={r.id}
      r={r}
      poster={r.projectId ? (projects[r.projectId]?.posterUrl ?? null) : null}
      projectExists={!!r.projectId && r.projectId in projects}
      onDelete={() => setDeleting(r)}
      onReveal={() => void openFolder(r.id)}
    />
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">{t.exportsPage.title}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t.exportsPage.lead}</p>
        </div>
        {rows?.length ? (
          <Button variant="secondary" onClick={() => void openFolder()} title={t.exportsPage.openFolderHint}>
            <FolderOpen />
            {t.exportsPage.openFolder}
          </Button>
        ) : null}
      </div>
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
        <div className="mt-8 flex flex-col gap-4">
          {items.map((it) =>
            it.kind === 'row' ? (
              <ul key={it.row.id} className="rounded-lg border border-border bg-surface">
                {row(it.row)}
              </ul>
            ) : (
              <section key={it.batch} className="rounded-lg border border-border bg-surface" data-testid="export-batch">
                <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold">{f(t.exportsPage.batchTitle, { n: it.rows.length })}</h2>
                    <p className="tabular text-[12px] text-fg-muted">
                      {f(t.exportsPage.batchProgress, { done: it.rows.filter((r) => r.status === 'succeeded').length, n: it.rows.length })}
                    </p>
                  </div>
                  {it.rows.some((r) => r.status === 'succeeded') ? (
                    <Button asChild size="sm" variant="primary">
                      <a href={`/api/exports/batches/${encodeURIComponent(it.batch)}/zip`} download>
                        <Download />
                        {t.exportsPage.downloadAll}
                      </a>
                    </Button>
                  ) : null}
                </div>
                <ul className="divide-y divide-border">{it.rows.map(row)}</ul>
              </section>
            ),
          )}
        </div>
      )}
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent
          title={t.exportsPage.deleteTitle}
          description={f(t.exportsPage.deleteConfirm, { name: deleting?.projectName ?? '' })}
          closeLabel={t.common.close}
        >
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t.common.cancel}
            </Button>
            <Button variant="primary" onClick={doDelete} loading={busy} data-testid="export-delete-confirm">
              {t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ExportRow({
  r,
  poster,
  projectExists,
  onDelete,
  onReveal,
}: {
  r: Row;
  poster: string | null;
  projectExists: boolean;
  onDelete: () => void;
  onReveal: () => void;
}) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const vertical = r.height > r.width || (!r.width && r.settings.preset === 'shorts');
  return (
    <li className="flex flex-wrap items-center gap-4 px-4 py-3" data-testid="export-row">
      <div className={vertical ? 'h-16 w-9 shrink-0' : 'h-12 w-20 shrink-0'}>
        {poster ? (
          <img src={poster} alt="" className="size-full rounded-sm border border-border object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center rounded-sm border border-border bg-gray-950 text-gray-500">
            <Film className="size-4" aria-hidden />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {projectExists ? (
          <Link href={`/app/projects/${r.projectId}`} className="block truncate text-sm font-medium hover:underline" title={t.exportsPage.toProject}>
            {r.projectName}
          </Link>
        ) : (
          <p className="truncate text-sm font-medium">{r.projectName}</p>
        )}
        <p className="tabular text-[12px] text-fg-muted">
          {t.exporter.presets[r.settings.preset] ?? r.settings.preset}
          {r.width ? ` · ${r.width}×${r.height}` : ''}
          {r.duration ? ` · ${duration(r.duration)}` : ''}
          {r.size ? ` · ${bytes(r.size, locale)}` : ''} · {relativeTime(r.createdAt, locale)}
        </p>
        {r.status === 'failed' && r.errorCode === 'disk_full' ? <p className="mt-0.5 text-[12px] text-accent-fg">{t.errors.disk_full}</p> : null}
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
      {projectExists ? (
        <Button asChild size="iconSm" variant="ghost" aria-label={`${t.exportsPage.toProject}: ${r.projectName}`}>
          <Link href={`/app/projects/${r.projectId}`}>
            <Pencil />
          </Link>
        </Button>
      ) : null}
      {r.previewUrl ? (
        <Button asChild size="sm" variant="ghost">
          <a href={r.previewUrl} target="_blank" rel="noreferrer" aria-label={`${t.exporter.play}: ${r.projectName}`}>
            <Play />
            {t.exporter.play}
          </a>
        </Button>
      ) : null}
      {r.status === 'succeeded' ? (
        <Button
          size="iconSm"
          variant="ghost"
          aria-label={`${t.exportsPage.openFolder}: ${r.projectName}`}
          title={t.exportsPage.openFolderHint}
          onClick={onReveal}
        >
          <FolderOpen />
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
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t.youtube.copied : t.youtube.copy}
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
      <Button size="iconSm" variant="ghost" aria-label={`${t.common.delete}: ${r.projectName}`} onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  );
}
