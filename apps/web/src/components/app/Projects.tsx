'use client';

import { AlertTriangle, Copy, Film, MoreHorizontal, Pencil, Play, Sparkles, Trash2, UploadCloud } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
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
        <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <ProjectCard p={p} onChanged={load} />
            </li>
          ))}
        </ul>
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
        </DialogContent>
      </Dialog>
      <span className="sr-only" aria-live="polite">
        {projects ? f(t.projects.shots, { n: projects.length }) : ''}
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
    </div>
  );
}

function ProjectCard({ p, onChanged }: { p: ProjectSummary; onChanged: () => void }) {
  const { t, f, locale } = useI18n();
  const router = useRouter();
  const [rename, setRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(p.name);
  const [busy, setBusy] = useState(false);
  const job = p.processing.find((j) => j.kind === 'ingest') ?? p.processing.find((j) => j.kind === 'analyze');

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
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'absolute bottom-3 right-0 inline-flex size-8 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-sunken hover:text-fg',
            )}
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
    </div>
  );
}
