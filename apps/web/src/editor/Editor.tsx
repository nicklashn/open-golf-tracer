'use client';

import { ArrowLeft, Check, CircleAlert, CloudUpload, History, Keyboard, Loader2, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { byTimeline, migrateProject, timelineDuration, type Shot } from '@golf/schema';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { UploadTray } from '@/components/app/UploadTray';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useJobEvents, type JobEvent } from '@/lib/events';
import { useI18n } from '@/lib/i18n/client';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/cn';
import { saveNow, startAutosave } from './autosave';
import { ExportDialog, ExportStatus, Onboarding, ShortcutsDialog, VersionsDialog, type ExportRow } from './Dialogs';
import { filmedDay } from './course';
import { AutoVideoDialog } from './AutoVideo';
import { Inspector } from './Inspector';
import { LayersPanel, MediaPanel, ShotsPanel, TemplatesPanel } from './LeftPanels';
import * as ops from './ops';
import { Preview, player } from './Preview';
import { ScorePanel } from './ScorePanel';
import { useEditor, type MediaInfo } from './store';
import { Timeline } from './Timeline';
import { Transport, frameStep } from './Transport';
import { useShortcuts } from './shortcuts';

/** Five tabs in the 280 px left panel: a little tighter than the default. */
const TAB = 'px-1.5 text-[12px]';

interface Loaded {
  document: unknown;
  docVersion: number;
  media: MediaInfo[];
  processing: { id: string; kind: string; status: string; progress: number; message: string; mediaId: string | null }[];
  name: string;
}

export function Editor({ projectId }: { projectId: string }) {
  const { t, f, locale } = useI18n();
  const router = useRouter();
  const me = useMe((s) => s.me);
  const patchMe = useMe((s) => s.patch);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // "Make a video for me" is the one way to make a video; the store flag lets panels open it too.
  const autoOpen = useEditor((s) => s.makeOpen);
  const setAutoOpen = useCallback((o: boolean) => useEditor.setState({ makeOpen: o }), []);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [leftTab, setLeftTab] = useState('shots');
  const [onboarding, setOnboarding] = useState(false);
  const saveState = useEditor((s) => s.saveState);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const name = useEditor((s) => s.doc?.name ?? '');
  const proxyPending = useEditor((s) => Object.values(s.media).some((m) => m.kind === 'video' && !m.urls.proxy && m.status !== 'failed'));
  const ingesting = useEditor((s) => s.ingesting);
  const desktop = useIsDesktop();
  // A raw upload (no format chosen, no graphics yet): making the video is the next step, not exporting.
  const raw = useEditor((s) => s.doc?.format.aspect === 'original' && s.doc.layers.length === 0);
  /** Analyses still queued or running in this project (a round has one per clip). */
  const analysing = useRef(new Set<string>());
  /** Videos waiting for answers the user was told about (once each). */
  const asked = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const p = await api<Loaded>(`/projects/${projectId}`);
      const doc = migrateProject(p.document);
      useEditor.getState().init({ projectId, doc, docVersion: p.docVersion, media: p.media });
      const an = p.processing.find((j) => j.kind === 'analyze');
      analysing.current = new Set(p.processing.filter((j) => j.kind === 'analyze').map((j) => j.id));
      useEditor.setState({
        makeOpen: false, // the store outlives a project: a dialog open in the last one stays there
        analysis: { running: !!an, progress: an?.progress ?? 0, message: an?.message ?? '', mediaId: an?.mediaId ?? null },
        ingesting: Object.fromEntries(p.processing.filter((j) => j.kind === 'ingest' && j.mediaId).map((j) => [j.mediaId!, j.progress])),
      });
      if (doc.shots[0]) useEditor.getState().select({ kind: 'shot', id: doc.shots[0].id });
      setState('ready');
    } catch (e) {
      setError(errorMessage(e, t));
      setState('error');
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state !== 'ready') return;
    const stop = startAutosave();
    return () => {
      stop();
      void saveNow();
    };
  }, [state]);

  useEffect(() => {
    if (state === 'ready' && me && !me.onboardingDone) setOnboarding(true);
  }, [state, me]);

  /** Shots the server already found for a clip that just joined the timeline. */
  const pullShots = useCallback(
    async (mediaId: string) => {
      const res = await api<{ document: unknown }>(`/projects/${projectId}`).catch(() => null);
      if (!res) return;
      const server = migrateProject(res.document);
      const doc = useEditor.getState().doc;
      const fresh = server.shots.filter((x) => x.mediaId === mediaId && !doc.shots.some((y) => y.id === x.id) && !doc.dismissedShots.includes(x.id));
      const place = server.media[mediaId]?.place;
      if (!fresh.length && !place) return;
      useEditor.getState().silently((d) => {
        d.shots = [...d.shots, ...fresh].sort(byTimeline(d.clips)) as typeof d.shots;
        if (place && d.media[mediaId] && !d.media[mediaId].place) d.media[mediaId].place = place;
      });
    },
    [projectId],
  );

  // Live updates: proxy ready, shots found while analysing, retrack results, exports.
  const onEvent = useCallback(
    (ev: JobEvent) => {
      const s = useEditor.getState();
      const job = ev.job;
      if (job.kind === 'ingest' && job.mediaId) {
        const ing = { ...s.ingesting };
        if (job.status === 'queued' || job.status === 'running') ing[job.mediaId] = job.progress;
        else delete ing[job.mediaId];
        useEditor.setState({ ingesting: ing });
        if (job.status === 'succeeded' && ev.media) {
          const m = ev.media as MediaInfo;
          s.setMedia(m);
          // Another clip of this project (a round) finished processing: put it on the timeline.
          if (m.kind === 'video' && !s.doc.media[m.id]) {
            ops.attachVideo(m);
            void pullShots(m.id);
          }
          player?.refreshSources();
        }
      }
      if (job.kind === 'analyze') {
        const running = job.status === 'queued' || job.status === 'running';
        if (running) analysing.current.add(job.id);
        else analysing.current.delete(job.id);
        // Between the clips of a round the card stays up: the next clip's analysis is queued.
        useEditor.setState({
          analysis: running
            ? { running, progress: job.progress, message: job.message, mediaId: job.mediaId }
            : { running: analysing.current.size > 0, progress: 0, message: '', mediaId: null },
        });
        if (ev.media && (ev.media as MediaInfo).kind === 'video' && !useEditor.getState().doc.media[(ev.media as MediaInfo).id]) {
          useEditor.getState().setMedia(ev.media as MediaInfo);
          ops.attachVideo(ev.media as MediaInfo);
          void pullShots((ev.media as MediaInfo).id);
        }
        if (ev.shots) {
          const doc = useEditor.getState().doc;
          // Shots of a clip that is not on the timeline yet arrive again once it is.
          const fresh = (ev.shots as Shot[]).filter((x) => doc.media[x.mediaId] && !doc.shots.some((y) => y.id === x.id) && !doc.dismissedShots.includes(x.id));
          if (fresh.length) {
            const parsed = migrateProject({ ...doc, shots: [...doc.shots, ...fresh] }).shots;
            useEditor.getState().silently((d) => {
              d.shots = parsed.sort(byTimeline(d.clips)) as typeof d.shots;
            });
            // First shot found while nothing is picked: show it, cued up just before the swing.
            if (!useEditor.getState().selection) {
              const first = parsed.find((x) => x.visible) ?? parsed[0];
              if (first) ops.jumpToShot(first);
            }
          }
        }
        if (ev.place && useEditor.getState().doc.media[ev.place.mediaId]) {
          const { mediaId, geo, ...rest } = ev.place;
          const media = useEditor.getState().doc.media[mediaId];
          const parsed = migrateProject({ ...useEditor.getState().doc, media: { [mediaId]: { ...media, geo: media.geo ?? geo ?? null, place: rest } } }).media[
            mediaId
          ];
          if (!media.place || !media.geo || (!media.place.hole && parsed.place?.hole)) {
            useEditor.getState().silently((d) => {
              d.media[mediaId].geo = parsed.geo;
              if ('course' in rest && (!d.media[mediaId].place || !d.media[mediaId].place!.hole)) d.media[mediaId].place = parsed.place;
            });
          }
          // "Round 2 May" becomes "Old Course – 2 May" once the course is known
          // (the name is also the exported file's and the video's title).
          const course = parsed.place?.course;
          const name = useEditor.getState().doc.name;
          const m = /^(?:Runde|Round) (.+)$/.exec(name);
          if (course && m) {
            // The day it was filmed (from the clips), not when the files were copied.
            const day = filmedDay(useEditor.getState().doc.media, locale) || m[1];
            useEditor.getState().edit('Name', (d) => {
              d.name = `${course} – ${day}`.slice(0, 120);
            });
          }
        }
        // A failed analysis is never silent: say which clip, and offer the way on.
        if (job.status === 'failed' && job.mediaId) {
          const mediaId = job.mediaId;
          const clip = useEditor.getState().doc.media[mediaId]?.name ?? '';
          toast.error(f(t.editor.analysisFailed, { name: clip }), t.editor.analysisFailedHint, {
            duration: 20_000,
            action: {
              label: t.common.retry,
              onClick: () => void api(`/projects/${projectId}/analyze`, { body: { mediaId } }).catch((e) => toast.error(errorMessage(e, t))),
            },
          });
        }
        // Once, when the last clip of the project is done: the next step, right where the eye is.
        if (job.status === 'succeeded' && !analysing.current.size && !Object.keys(useEditor.getState().ingesting).length) {
          const n = useEditor.getState().doc.shots.filter((x) => x.visible).length;
          if (n)
            toast.success(f(t.editor.analysisFound, { n }), t.editor.analysisNext, {
              action: { label: t.auto.open, onClick: () => setAutoOpen(true) },
              duration: 15_000,
            });
          else toast.info(t.editor.analysisNone, t.editor.analysisNoneHint, { duration: 10_000 });
        }
      }
      // A video waiting for answers (also one started before a reload): say so once, with the way back.
      if (job.kind === 'compose' && job.status === 'awaiting_answers' && !s.makeOpen && !asked.current.has(job.id)) {
        asked.current.add(job.id);
        toast.info(t.auto.waiting, t.auto.waitingHint, { action: { label: t.auto.answerNow, onClick: () => setAutoOpen(true) }, duration: 20_000 });
      }
      if (job.kind === 'retrack') {
        const shotId = (job.result?.shot as Shot | undefined)?.id;
        if (job.status === 'succeeded' && job.result?.shot) {
          const parsed = migrateProject({ ...useEditor.getState().doc, shots: [job.result.shot] }).shots[0];
          ops.insertShot(parsed);
          ops.jumpToShot(parsed);
        }
        if (job.status === 'failed') toast.error(t.shots.retrack, job.error || t.errors.generic);
        if (job.status !== 'queued' && job.status !== 'running') {
          const r = { ...useEditor.getState().retracking };
          for (const [k, v] of Object.entries(r)) if (v === job.id || k === shotId) delete r[k];
          useEditor.setState({ retracking: r });
        }
      }
      if (job.kind === 'export') {
        setExports((xs) =>
          xs.map((e) =>
            e.jobId === job.id
              ? {
                  ...e,
                  status: job.status === 'succeeded' ? 'succeeded' : job.status,
                  progress: job.progress,
                  url: ev.export?.url ?? e.url,
                  previewUrl: ev.export?.previewUrl ?? e.previewUrl,
                  projectName: ev.export?.projectName ?? e.projectName,
                  error: job.error,
                }
              : e,
          ),
        );
      }
    },
    [t, f, locale, pullShots, setAutoOpen, projectId],
  );
  useJobEvents(onEvent, state === 'ready' ? projectId : null);

  // Videos with GPS but no hole yet (the map server was busy during analysis): ask again.
  useEffect(() => {
    if (state !== 'ready') return;
    const missing = Object.values(useEditor.getState().doc.media).filter((m) => m.kind === 'video' && m.geo && !m.place);
    for (const m of missing) {
      void api<Record<string, unknown> | null>(`/geo/place?lat=${m.geo!.lat}&lon=${m.geo!.lon}`)
        .then((place) => {
          if (!place || !('course' in place)) return;
          const parsed = migrateProject({ ...useEditor.getState().doc, media: { [m.id]: { ...m, place } } }).media[m.id];
          useEditor.getState().silently((d) => {
            if (d.media[m.id] && !d.media[m.id].place) d.media[m.id].place = parsed.place;
          });
        })
        .catch(() => undefined);
    }
  }, [state]);

  async function retrack(mediaId: string, time: number, ball: { x: number; y: number } | null, shot?: Shot) {
    try {
      const job = await api<{ id: string }>(`/projects/${projectId}/retrack`, {
        body: { mediaId, impactTime: time, timeIsImpact: !!shot, ball, shotId: shot?.id ?? null, slowmo: shot?.slowmo ?? 1 },
      });
      useEditor.setState({ retracking: { ...useEditor.getState().retracking, [shot?.id ?? `new_${job.id}`]: job.id } });
      toast.info(t.shots.retracking, t.shots.addManualStep2);
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }

  // A shot to show whose clip is no longer on the timeline: say so, and offer to put it back.
  useEffect(() => {
    ops.onShotMissing((shot) =>
      toast.info(t.shots.notOnTimeline, t.shots.notOnTimelineHint, {
        duration: 10_000,
        action: { label: t.shots.putBack, onClick: () => ops.restoreShot(shot) && ops.jumpToShot(shot) },
      }),
    );
    return () => ops.onShotMissing(null);
  }, [t]);

  useShortcuts({
    enabled: state === 'ready' && !exportOpen && !versionsOpen,
    onHelp: () => setShortcutsOpen(true),
    onExport: () => setExportOpen(true),
  });

  async function finishOnboarding() {
    setOnboarding(false);
    patchMe({ onboardingDone: true });
    await api('/account', { method: 'PATCH', body: { onboarding_done: true } }).catch(() => undefined);
  }

  if (state === 'loading') {
    return (
      <div data-theme="dark" className="flex h-screen flex-col items-center justify-center gap-4 bg-bg text-fg">
        <Birdie mood="think" size={96} />
        <p className="text-sm text-fg-muted">{t.editor.loadingProject}</p>
        <Skeleton className="h-2 w-48" />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div data-theme="dark" className="flex h-screen flex-col items-center justify-center gap-4 bg-bg px-6 text-center text-fg">
        <Birdie mood="confused" size={96} />
        <p className="max-w-md text-sm">{error}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => router.push('/app')}>
            {t.editor.back}
          </Button>
          <Button variant="primary" onClick={() => void load()}>
            {t.common.retry}
          </Button>
        </div>
      </div>
    );
  }

  const SaveIcon = saveState === 'saved' ? Check : saveState === 'saving' ? Loader2 : saveState === 'dirty' ? CloudUpload : CircleAlert;

  return (
    <div data-theme="dark" className="flex h-[100dvh] flex-col overflow-hidden bg-bg text-fg">
      {/* top bar */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <Tooltip label={t.editor.back}>
          <Button asChild variant="ghost" size="iconSm" aria-label={t.editor.back}>
            <Link href="/app" onClick={() => void saveNow()}>
              <ArrowLeft />
            </Link>
          </Button>
        </Tooltip>
        <input
          aria-label={t.common.rename}
          className="h-8 w-[min(320px,30vw)] truncate rounded-sm bg-transparent px-2 text-sm font-medium outline-none hover:bg-surface-sunken focus:bg-surface-sunken"
          value={name}
          onChange={(e) => ops.rename(e.target.value)}
          placeholder={t.editor.untitled}
        />
        <span
          className={cn(
            'hidden items-center gap-1.5 text-[12px] sm:flex',
            saveState === 'error' || saveState === 'conflict' ? 'text-accent-fg' : 'text-fg-subtle',
          )}
          role="status"
          data-testid="save-state"
        >
          <SaveIcon className={cn('size-3.5', saveState === 'saving' && 'animate-spin')} aria-hidden />
          {t.editor.saveState[saveState]}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip label={t.editor.undo} shortcut="⌘Z">
            <Button variant="ghost" size="iconSm" aria-label={t.editor.undo} disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
              <Undo2 />
            </Button>
          </Tooltip>
          <Tooltip label={t.editor.redo} shortcut="⇧⌘Z">
            <Button variant="ghost" size="iconSm" aria-label={t.editor.redo} disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
              <Redo2 />
            </Button>
          </Tooltip>
          <Tooltip label={t.editor.versions}>
            <Button variant="ghost" size="iconSm" aria-label={t.editor.versions} onClick={() => setVersionsOpen(true)} className="hidden sm:inline-flex">
              <History />
            </Button>
          </Tooltip>
          <Tooltip label={t.editor.shortcuts} shortcut="?">
            <Button variant="ghost" size="iconSm" aria-label={t.editor.shortcuts} onClick={() => setShortcutsOpen(true)} className="hidden lg:inline-flex">
              <Keyboard />
            </Button>
          </Tooltip>
          <Button
            variant={raw ? 'primary' : 'secondary'}
            size="sm"
            className="ml-2"
            onClick={() => setAutoOpen(true)}
            data-testid="open-auto"
            aria-label={t.auto.open}
          >
            <Sparkles />
            <span className="hidden sm:inline">{t.auto.open}</span>
          </Button>
          <Button variant={raw ? 'secondary' : 'primary'} size="sm" className="ml-2" onClick={() => setExportOpen(true)} data-testid="open-export">
            {t.editor.export}
          </Button>
        </div>
      </header>

      {proxyPending || Object.keys(ingesting).length ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-1.5 text-[12px] text-fg-muted" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t.editor.proxyPending}
        </div>
      ) : null}

      {/* desktop layout */}
      {desktop ? (
        <>
          <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_320px]">
            <aside className="flex min-h-0 flex-col border-r border-border bg-surface" aria-label={t.editor.panels.shots}>
              <Tabs value={leftTab} onValueChange={setLeftTab} className="flex min-h-0 flex-1 flex-col">
                <TabsList label={t.editor.panels.shots} className="gap-0 px-1">
                  <TabsTrigger value="shots" className={TAB}>
                    {t.editor.panels.shots}
                  </TabsTrigger>
                  <TabsTrigger value="score" className={TAB}>
                    {t.editor.panels.score}
                  </TabsTrigger>
                  <TabsTrigger value="layers" className={TAB}>
                    {t.editor.panels.layers}
                  </TabsTrigger>
                  <TabsTrigger value="templates" className={TAB}>
                    {t.editor.panels.templates}
                  </TabsTrigger>
                  <TabsTrigger value="media" className={TAB}>
                    {t.editor.panels.media}
                  </TabsTrigger>
                </TabsList>
                <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
                  <TabsContent value="shots">
                    <ShotsPanel />
                  </TabsContent>
                  <TabsContent value="score">
                    <ScorePanel />
                  </TabsContent>
                  <TabsContent value="layers">
                    <LayersPanel />
                  </TabsContent>
                  <TabsContent value="templates">
                    <TemplatesPanel />
                  </TabsContent>
                  <TabsContent value="media">
                    <MediaPanel />
                  </TabsContent>
                </div>
              </Tabs>
            </aside>
            <main className="flex min-h-0 min-w-0 flex-col bg-bg-subtle" id="main">
              <Preview onRequestRetrack={(mediaId, time, ball) => void retrack(mediaId, time, ball)} />
              <Transport />
            </main>
            <aside className="scrollbar-thin min-h-0 overflow-y-auto border-l border-border bg-surface" aria-label={t.editor.panels.properties}>
              <Inspector onRetrack={(shot) => void retrack(shot.mediaId, shot.impactTime, shot.constraints.start ?? shot.anchor, shot)} />
            </aside>
          </div>
          <div className="flex h-[240px] shrink-0 flex-col">
            <Timeline />
          </div>
        </>
      ) : (
        /* compact layout (tablet/phone): preview, shots, properties, export */
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-[45vh] min-h-[220px] flex-col bg-bg-subtle">
            <Preview onRequestRetrack={(mediaId, time, ball) => void retrack(mediaId, time, ball)} />
            <Transport />
          </div>
          <p className="border-y border-border px-4 py-2 text-[12px] text-fg-muted">{t.editor.mobileNotice}</p>
          <Tabs defaultValue="shots" className="flex min-h-0 flex-1 flex-col">
            <TabsList label={t.editor.panels.shots} className="px-2">
              <TabsTrigger value="shots">{t.editor.panels.shots}</TabsTrigger>
              <TabsTrigger value="score">{t.editor.panels.score}</TabsTrigger>
              <TabsTrigger value="layers">{t.editor.panels.layers}</TabsTrigger>
              <TabsTrigger value="props">{t.editor.panels.properties}</TabsTrigger>
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TabsContent value="shots">
                <ShotsPanel />
              </TabsContent>
              <TabsContent value="score">
                <ScorePanel />
              </TabsContent>
              <TabsContent value="layers">
                <LayersPanel />
              </TabsContent>
              <TabsContent value="props">
                <Inspector onRetrack={(shot) => void retrack(shot.mediaId, shot.impactTime, shot.constraints.start ?? shot.anchor, shot)} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      )}

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} onStarted={(e) => setExports((x) => [...x, e])} />
      <AutoVideoDialog open={autoOpen} onOpenChange={setAutoOpen} />
      <ExportStatus items={exports} onClear={(id) => setExports((x) => x.filter((e) => e.id !== id))} />
      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {onboarding ? (
        <Onboarding
          onDone={finishOnboarding}
          onMake={() => {
            void finishOnboarding();
            setAutoOpen(true);
          }}
        />
      ) : null}
      <UploadTray />
      <ConflictDialog />
      <span className="sr-only" aria-live="polite">
        {timelineDuration(useEditor.getState().doc).toFixed(0)}
      </span>
    </div>
  );
}

function ConflictDialog() {
  const { t } = useI18n();
  const state = useEditor((s) => s.saveState);
  const projectId = useEditor((s) => s.projectId);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={state === 'conflict'}>
      <DialogContent title={t.editor.conflictTitle} description={t.editor.conflictLead} hideClose>
        <DialogFooter>
          <Button
            variant="secondary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const p = await api<Loaded>(`/projects/${projectId}`);
                useEditor.getState().init({ projectId, doc: migrateProject(p.document), docVersion: p.docVersion, media: p.media });
              } catch (e) {
                if (!(e instanceof ApiError)) throw e;
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.editor.loadTheirs}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void saveNow(true)}>
            {t.editor.keepMine}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { frameStep };

const mq = '(min-width: 1024px)';
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(mq);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(mq).matches,
    () => true,
  );
}
