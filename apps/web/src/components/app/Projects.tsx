'use client';

import { AlertTriangle, Camera, ChevronDown, Copy, Download, Film, MoreHorizontal, Pencil, Play, Search, Sparkles, Trash2, UploadCloud } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Select } from '@/components/ui/controls';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Badge, ProgressBar, Skeleton } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useJobEvents, type JobInfo } from '@/lib/events';
import { jobMessage } from '@/lib/jobMessage';
import { bytes, duration, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n/client';
import { useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/cn';
import { ExportAllDialog, RunningExports } from './ExportBatch';
import { UploadTray } from './UploadTray';

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  posterUrl: string | null;
  duration: number;
  shots: number;
  aspect: string;
  processing: JobInfo[];
  isDemo: boolean;
  failed: boolean;
  /** A video made by "Make a video for me": the round it came from and the run that made it. */
  sourceId?: string | null;
  runId?: string | null;
  runKind?: string | null;
}

export type ProjectSort = 'newest' | 'name';

export interface ProjectGroup {
  p: ProjectSummary;
  /** Videos made from it, newest first. */
  made: ProjectSummary[];
}

/**
 * Projects as the page shows them: videos made from a round under that round, filtered by name
 * (a round shows when it or one of its videos matches) and sorted. A video whose round is gone
 * stands on its own.
 */
export function groupProjects(projects: ProjectSummary[], query: string, sort: ProjectSort, locale: 'da' | 'en'): ProjectGroup[] {
  const ids = new Set(projects.map((p) => p.id));
  const made = new Map<string, ProjectSummary[]>();
  for (const p of projects) {
    if (p.sourceId && p.sourceId !== p.id && ids.has(p.sourceId)) made.set(p.sourceId, [...(made.get(p.sourceId) ?? []), p]);
  }
  const q = query.trim().toLocaleLowerCase(locale);
  const hit = (p: ProjectSummary) => !q || p.name.toLocaleLowerCase(locale).includes(q);
  const newest = (a: ProjectSummary, b: ProjectSummary) => b.updatedAt.localeCompare(a.updatedAt);
  const groups: ProjectGroup[] = [];
  for (const p of projects) {
    if (p.sourceId && ids.has(p.sourceId) && p.sourceId !== p.id) continue;
    const kids = [...(made.get(p.id) ?? [])].sort(newest);
    if (hit(p)) groups.push({ p, made: kids });
    else if (kids.some(hit)) groups.push({ p, made: kids.filter(hit) });
  }
  const latest = (g: ProjectGroup) => [g.p, ...g.made].reduce((a, b) => (b.updatedAt > a ? b.updatedAt : a), '');
  return groups.sort(
    sort === 'name' ? (a, b) => a.p.name.localeCompare(b.p.name, locale, { sensitivity: 'base' }) : (a, b) => latest(b).localeCompare(latest(a)),
  );
}

export function ProjectsPage() {
  const { t, f, locale } = useI18n();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  /** Several videos picked at once: one round video, or a project each? */
  const [several, setSeveral] = useState<File[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('newest');
  const groups = useMemo(() => (projects ? groupProjects(projects, query, sort, locale) : []), [projects, query, sort, locale]);

  const load = useCallback(async () => {
    try {
      const p = await api<{ projects: ProjectSummary[] }>('/projects');
      setProjects(p.projects);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useJobEvents((ev) => {
    setProjects(
      (ps) =>
        ps?.map((p) => {
          if (p.id !== ev.job.projectId || ev.job.kind === 'export' || ev.job.kind === 'compose') return p;
          const others = p.processing.filter((j) => j.id !== ev.job.id);
          const active = ev.job.status === 'queued' || ev.job.status === 'running';
          return { ...p, processing: active ? [...others, ev.job] : others, shots: ev.shots ? Math.max(p.shots, ev.shots.length) : p.shots };
        }) ?? ps,
    );
    if (ev.job.status === 'succeeded' && (ev.job.kind === 'ingest' || ev.job.kind === 'analyze' || ev.job.kind === 'compose')) void load();
  });

  async function onFiles(files: FileList | File[]) {
    const vids = Array.from(files);
    if (!vids.length) return;
    if (vids.length > 1) {
      setSeveral(vids);
      return;
    }
    await separately(vids);
  }

  async function separately(vids: File[]) {
    await Promise.all(
      vids.map(async (file) => {
        try {
          const res = await uploadFile(file, { kind: 'video' });
          if (res.projectId) void load();
          if (vids.length === 1 && res.projectId) router.push(`/app/projects/${res.projectId}`);
        } catch {
          // The upload tray shows what went wrong, with the file's name.
        }
      }),
    );
  }

  /** All clips in one project, in the order they were filmed (the server merges each in). */
  async function asRound(vids: File[]) {
    let p: ProjectSummary;
    try {
      const day = new Date(Math.min(...vids.map((v) => v.lastModified))).toLocaleDateString(locale === 'da' ? 'da-DK' : 'en-GB', {
        day: 'numeric',
        month: 'short',
      });
      p = await api<ProjectSummary>('/projects', { body: { name: f(t.projects.roundName, { date: day }) } });
    } catch (e) {
      toast.error(errorMessage(e, t));
      return;
    }
    void load();
    let opened = false;
    await Promise.all(
      vids.map(async (file) => {
        try {
          await uploadFile(file, { kind: 'video', projectId: p.id });
          // Open the editor as soon as the first clip is in; the rest join while you work.
          if (!opened) {
            opened = true;
            router.push(`/app/projects/${p.id}`);
          }
        } catch {
          // Shown in the upload tray, which follows into the editor.
        }
      }),
    );
  }

  async function demo() {
    setDemoBusy(true);
    try {
      const p = await api<ProjectSummary>(`/projects/demo?locale=${locale}`, { method: 'POST' });
      router.push(`/app/projects/${p.id}`);
    } catch (e) {
      toast.error(errorMessage(e, t));
      setDemoBusy(false);
    }
  }

  return (
    <div
      className="relative"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void onFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{t.projects.title}</h1>
        <div className="flex gap-2">
          {projects?.length ? (
            <Button variant="secondary" onClick={demo} loading={demoBusy}>
              <Sparkles />
              {t.projects.tryDemo}
            </Button>
          ) : null}
          {/* With no projects the empty state below carries the same button, bigger. */}
          {projects?.length !== 0 ? (
            <Button variant="primary" onClick={() => fileInput.current?.click()}>
              <UploadCloud />
              {t.projects.newVideo}
            </Button>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            accept="video/*,.mov,.mp4,.m4v,.mkv"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              if (e.target.files) void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-8 flex items-center gap-3 rounded-md border border-border bg-surface p-4 text-sm">
          <AlertTriangle className="size-5 text-accent-fg" />
          <span className="flex-1">{error}</span>
          <Button size="sm" onClick={load}>
            {t.common.retry}
          </Button>
        </div>
      ) : projects === null ? (
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i}>
              <Skeleton className="aspect-video w-full rounded-md" />
              <Skeleton className="mt-3 h-4 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState onBrowse={() => fileInput.current?.click()} onDemo={demo} demoBusy={demoBusy} />
      ) : (
        <>
          <RunningExports />
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.projects.searchPlaceholder}
                aria-label={t.projects.search}
                className="pl-9"
                data-testid="projects-search"
              />
            </div>
            <div className="w-44">
              <Select
                label={t.projects.sort}
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'newest', label: t.projects.sortNewest },
                  { value: 'name', label: t.projects.sortName },
                ]}
              />
            </div>
          </div>
          {groups.length ? (
            <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => (
                <li key={g.p.id}>
                  <ProjectCard p={g.p} made={g.made} searching={!!query.trim()} onChanged={load} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-8 text-sm text-fg-muted">{f(t.projects.noMatch, { q: query.trim() })}</p>
          )}
        </>
      )}

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-gray-1000/50 p-6">
          <div className="flex flex-col items-center rounded-lg border-2 border-dashed border-white/80 bg-gray-950/80 px-12 py-10 text-white">
            <UploadCloud className="size-10" aria-hidden />
            <p className="mt-3 text-lg font-semibold">{t.projects.dropHere}</p>
          </div>
        </div>
      ) : null}
      <UploadTray />
      <Dialog open={!!several} onOpenChange={(o) => !o && setSeveral(null)}>
        <DialogContent title={f(t.projects.severalTitle, { n: several?.length ?? 0 })} description={t.projects.severalHint} wide>
          <p className="mb-3 text-[13px] text-fg-muted" data-testid="several-gps">
            {t.projects.severalGps}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="flex flex-col gap-2 rounded-lg border-2 border-accent bg-surface p-4 text-left hover:bg-surface-sunken"
              onClick={() => {
                const v = several ?? [];
                setSeveral(null);
                void asRound(v);
              }}
            >
              <Film className="size-6 text-accent-fg" />
              <span className="font-semibold">{t.projects.asRound}</span>
              <span className="text-[13px] text-fg-muted">{t.projects.asRoundHint}</span>
            </button>
            <button
              type="button"
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-left hover:bg-surface-sunken"
              onClick={() => {
                const v = several ?? [];
                setSeveral(null);
                void separately(v);
              }}
            >
              <Copy className="size-6 text-fg-muted" />
              <span className="font-semibold">{t.projects.separately}</span>
              <span className="text-[13px] text-fg-muted">{t.projects.separatelyHint}</span>
            </button>
          </div>
          <BeforeFilming className="mt-4" />
        </DialogContent>
      </Dialog>
      <span className="sr-only" aria-live="polite">
        {projects ? (projects.length === 1 ? t.projects.oneProject : f(t.projects.count, { n: projects.length })) : ''}
      </span>
    </div>
  );
}

/** The first thing a new user sees: what the app does in three steps, and the two ways to start. */
function EmptyState({ onBrowse, onDemo, demoBusy }: { onBrowse: () => void; onDemo: () => void; demoBusy: boolean }) {
  const { t, f, locale } = useI18n();
  const me = useMe((s) => s.me);
  const [b1, b2] = t.projects.dropLead.split('{browse}');
  return (
    <div
      className="mt-8 flex flex-col items-center rounded-lg border-2 border-dashed border-border-strong bg-bg-subtle px-6 py-12 text-center"
      data-testid="projects-empty"
    >
      <Birdie mood="wave" size={96} />
      <h2 className="mt-4 text-xl font-semibold">{t.projects.emptyTitle}</h2>
      <p className="mt-2 text-sm text-fg-muted">{t.projects.emptyLead}</p>
      <ol className="mt-4 grid max-w-3xl gap-3 text-left sm:grid-cols-3">
        {t.projects.emptySteps.map((step, i) => (
          <li key={i} className="flex gap-3 rounded-md border border-border bg-surface p-3 text-[13px] leading-snug">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-white" aria-hidden>
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <Button className="mt-6" variant="primary" size="lg" onClick={onBrowse}>
        <UploadCloud />
        {t.projects.pickVideos}
      </Button>
      <p className="mt-3 text-sm">
        {b1}
        <button type="button" onClick={onBrowse} className="font-medium text-accent-fg underline-offset-4 hover:underline">
          {t.projects.browse}
        </button>
        {b2}
      </p>
      {me ? <p className="mt-1 text-[12px] text-fg-subtle">{f(t.projects.formats, { size: bytes(me.limits.max_upload_bytes, locale) })}</p> : null}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm text-fg-muted">
        <span>{t.projects.orDemo}</span>
        <Button variant="secondary" onClick={onDemo} loading={demoBusy}>
          <Sparkles />
          {t.projects.tryDemo}
        </Button>
      </div>
      <BeforeFilming className="mt-8 max-w-3xl text-left" />
    </div>
  );
}

/** What makes the analysis work, said before the round: GPS on, a tripod, and the original files. */
function BeforeFilming({ className }: { className?: string }) {
  const { t } = useI18n();
  const B = t.projects.beforeFilming;
  return (
    <section className={cn('rounded-md border border-border bg-surface p-4', className)} data-testid="before-filming">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <Camera className="size-4 text-accent-fg" aria-hidden />
        {B.title}
      </h2>
      <ul className="mt-2 grid list-disc gap-1 pl-5 text-[13px] leading-snug text-fg-muted">
        {B.items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </section>
  );
}

function ProjectCard({ p, made, searching, onChanged }: { p: ProjectSummary; made: ProjectSummary[]; searching: boolean; onChanged: () => void }) {
  const { t, f, locale } = useI18n();
  const job = p.processing.find((j) => j.kind === 'ingest') ?? p.processing.find((j) => j.kind === 'analyze');

  return (
    <div>
      <div className="group relative">
        <Link href={`/app/projects/${p.id}`} className="block rounded-md focus-visible:outline-offset-4">
          <div className="relative aspect-video overflow-hidden rounded-md border border-border bg-gray-950">
            {p.posterUrl ? (
              <img src={p.posterUrl} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" loading="lazy" />
            ) : (
              <div className="flex size-full items-center justify-center text-gray-500">
                <Play className="size-8" aria-hidden />
              </div>
            )}
            {p.duration > 0 ? (
              <span className="tabular absolute bottom-2 right-2 rounded-sm bg-gray-950/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
                {duration(p.duration)}
              </span>
            ) : null}
            {p.isDemo || p.aspect === '16:9' || p.aspect === '9:16' ? (
              <span className="absolute left-2 top-2 flex gap-1">
                {p.isDemo ? <Badge>{t.projects.demoBadge}</Badge> : null}
                {/* A made video (YouTube or a short) tells itself apart from the clips it came from. */}
                {p.aspect === '16:9' || p.aspect === '9:16' ? <Badge>{p.aspect}</Badge> : null}
              </span>
            ) : null}
            {job ? (
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-gray-950/90 to-transparent p-3 pt-8">
                <p className="text-[12px] font-medium text-white">
                  {job.kind === 'ingest' ? t.projects.processing : t.projects.analyzing}
                  <span className="font-normal text-white/80"> {jobMessage(job.message, t)}</span>
                </p>
                <ProgressBar className="mt-1.5 bg-white/20" value={job.status === 'queued' ? null : job.progress} label={jobMessage(job.message, t)} />
              </div>
            ) : null}
            {p.failed ? (
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gray-950/85 px-3 py-2 text-[12px] text-red-300">
                <AlertTriangle className="size-3.5" />
                {t.projects.failed}
              </div>
            ) : null}
          </div>
          <div className="mt-3 pr-10">
            <h2 className="truncate text-[15px] font-medium">{p.name}</h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              {p.shots === 0 ? t.projects.noShots : p.shots === 1 ? t.projects.oneShot : f(t.projects.shots, { n: p.shots })} ·{' '}
              {f(t.projects.updated, { when: relativeTime(p.updatedAt, locale) })}
            </p>
          </div>
        </Link>
        <ProjectMenu p={p} onChanged={onChanged} className="absolute bottom-3 right-0" />
      </div>
      {made.length ? <MadeVideos made={made} open={searching} onChanged={onChanged} /> : null}
    </div>
  );
}

/** The videos made from a round, folded under it; "Export all" for each run that made several. */
function MadeVideos({ made, open: searching, onChanged }: { made: ProjectSummary[]; open: boolean; onChanged: () => void }) {
  const { t, f } = useI18n();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<{ ids: string[]; vertical: boolean } | null>(null);
  const shown = open || searching;
  // Runs in the order of their newest video; videos without a run (older projects) stand alone.
  const runs = new Map<string, ProjectSummary[]>();
  for (const m of made) runs.set(m.runId ?? m.id, [...(runs.get(m.runId ?? m.id) ?? []), m]);
  return (
    <div className="mt-2 rounded-md border border-border bg-surface" data-testid="made-videos">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-medium text-fg-muted hover:text-fg"
      >
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', !shown && '-rotate-90')} aria-hidden />
        {made.length === 1 ? t.projects.madeFromOne : f(t.projects.madeFrom, { n: made.length })}
      </button>
      {shown ? (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          {[...runs.values()].map((run) => (
            <div key={run[0].runId ?? run[0].id}>
              {run.length > 1 ? (
                <div className="flex items-center justify-between gap-2 px-1 pb-1">
                  <span className="truncate text-[12px] text-fg-subtle">{runLabel(run[0].runKind, t)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExporting({ ids: run.map((m) => m.id), vertical: run.every((m) => m.aspect === '9:16') })}
                    data-testid="export-all"
                  >
                    <Download />
                    {f(t.projects.exportAll, { n: run.length })}
                  </Button>
                </div>
              ) : null}
              <ul className="flex flex-col">
                {run.map((m) => (
                  <li key={m.id} className="group relative flex items-center gap-2.5 rounded-sm px-1 py-1 hover:bg-surface-sunken">
                    <Link href={`/app/projects/${m.id}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm">
                      <span className={cn('shrink-0 overflow-hidden rounded-sm bg-gray-950', m.aspect === '9:16' ? 'h-10 w-6' : 'h-7 w-12')}>
                        {m.posterUrl ? <img src={m.posterUrl} alt="" className="size-full object-cover" loading="lazy" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px]">{m.name}</span>
                      {m.aspect === '16:9' || m.aspect === '9:16' ? <Badge>{m.aspect}</Badge> : null}
                    </Link>
                    <ProjectMenu p={m} onChanged={onChanged} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      <ExportAllDialog open={!!exporting} onOpenChange={(o) => !o && setExporting(null)} projectIds={exporting?.ids ?? []} vertical={!!exporting?.vertical} />
    </div>
  );
}

function runLabel(kind: string | null | undefined, t: ReturnType<typeof useI18n>['t']): string {
  return kind === 'youtube' ? t.make.youtube : kind === 'highlight' ? t.make.highlight : kind === 'shorts' ? t.make.perShot : t.auto.open;
}

/** Edit, rename, duplicate and delete a project. */
function ProjectMenu({ p, onChanged, className }: { p: ProjectSummary; onChanged: () => void; className?: string }) {
  const { t, f } = useI18n();
  const router = useRouter();
  const [rename, setRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(p.name);
  const [busy, setBusy] = useState(false);

  async function doRename() {
    setBusy(true);
    try {
      await api(`/projects/${p.id}`, { method: 'PATCH', body: { name } });
      setRename(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }
  async function doDelete() {
    setBusy(true);
    try {
      await api(`/projects/${p.id}`, { method: 'DELETE' });
      setConfirmDelete(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }
  async function duplicate() {
    try {
      await api(`/projects/${p.id}/duplicate`, { method: 'POST' });
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-sunken hover:text-fg', className)}
            aria-label={`${t.common.more}: ${p.name}`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<Play />} onSelect={() => router.push(`/app/projects/${p.id}`)}>
            {t.common.edit}
          </MenuItem>
          <MenuItem icon={<Pencil />} onSelect={() => setRename(true)}>
            {t.common.rename}
          </MenuItem>
          <MenuItem icon={<Copy />} onSelect={duplicate}>
            {t.common.duplicate}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(true)}>
            {t.common.delete}
          </MenuItem>
        </MenuContent>
      </Menu>

      <Dialog open={rename} onOpenChange={setRename}>
        <DialogContent title={t.projects.renameTitle} closeLabel={t.common.close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void doRename();
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t.common.rename} autoFocus maxLength={120} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRename(false)}>
                {t.common.cancel}
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
                {t.common.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent title={t.projects.deleteTitle} description={f(t.projects.deleteLead, { name: p.name })} closeLabel={t.common.close}>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t.common.cancel}
            </Button>
            <Button variant="primary" onClick={doDelete} loading={busy}>
              {t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
