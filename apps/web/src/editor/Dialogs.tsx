'use client';

import { Download, FolderOpen, History, Play, RotateCcw, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { outputSize, primaryMedia, type ExportPreset } from '@golf/schema';
import { useEffect, useState } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Kbd, ProgressBar } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import { saveNow } from './autosave';
import { useEditor } from './store';
import { migrateProject } from '@golf/schema';

export interface ExportRow {
  id: string;
  status: string;
  progress: number;
  message: string;
  url: string | null;
  jobId: string | null;
  width: number;
  height: number;
  createdAt: string;
  error: string;
  settings: { preset: ExportPreset };
  projectName?: string;
  previewUrl?: string | null;
}

export function ExportDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (o: boolean) => void; onStarted: (e: ExportRow) => void }) {
  const { t } = useI18n();
  const doc = useEditor((s) => s.doc);
  const inPoint = useEditor((s) => s.inPoint);
  const outPoint = useEditor((s) => s.outPoint);
  const [preset, setPreset] = useState<ExportPreset>('shorts');
  const [fps, setFps] = useState<'source' | '30' | '60'>('source');
  const [hdr, setHdr] = useState<'keep' | 'sdr'>('keep');
  const [range, setRange] = useState<'all' | 'selection'>('all');
  const [busy, setBusy] = useState(false);
  const media = primaryMedia(doc);

  useEffect(() => {
    if (open)
      setPreset(doc.format.aspect === '9:16' ? 'shorts' : doc.format.aspect === '16:9' || doc.format.aspect === 'original' ? 'youtube1080' : 'original');
  }, [open, doc.format.aspect]);

  const aspect = preset === 'shorts' ? '9:16' : doc.format.aspect;
  const size = media ? outputSize(aspect, preset, media) : null;
  const hasSelection = inPoint != null && outPoint != null && outPoint > inPoint;

  async function start() {
    setBusy(true);
    try {
      await saveNow(true);
      const body = {
        settings: {
          preset,
          fps: fps === 'source' ? 'source' : Number(fps),
          hdr,
          range: range === 'selection' && hasSelection ? { start: inPoint, end: outPoint } : null,
        },
        document: useEditor.getState().doc,
      };
      const e = await api<ExportRow>(`/projects/${useEditor.getState().projectId}/exports`, { body });
      onStarted(e);
      onOpenChange(false);
    } catch (err) {
      toast.error(t.exporter.failed, errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t.exporter.title} wide closeLabel={t.common.close}>
        <div className="grid gap-5">
          <div role="radiogroup" aria-label={t.exporter.preset} className="grid grid-cols-2 gap-2">
            {(['shorts', 'youtube1080', 'youtube4k', 'original'] as ExportPreset[]).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={preset === p}
                onClick={() => setPreset(p)}
                className="flex items-start justify-between rounded-md border border-border p-3 text-left hover:border-border-strong aria-checked:border-red-500 aria-checked:bg-red-500/10"
              >
                <span>
                  <span className="block text-sm font-medium">{t.exporter.presets[p]}</span>
                  <span className="block text-[12px] text-fg-muted">{t.exporter.presetDetail[p]}</span>
                </span>
              </button>
            ))}
          </div>
          {preset === 'shorts' && doc.format.aspect !== '9:16' ? (
            <p className="rounded-md bg-surface-sunken p-3 text-[13px] text-fg-muted">{t.exporter.shortsAspect}</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[13px] font-medium">{t.exporter.fps}</p>
              <Segmented
                label={t.exporter.fps}
                value={fps}
                onChange={setFps}
                options={[
                  { value: 'source', label: t.exporter.fpsSource },
                  { value: '30', label: '30' },
                  { value: '60', label: '60' },
                ]}
              />
            </div>
            {media?.hdr ? (
              <div>
                <p className="mb-1.5 text-[13px] font-medium">{t.exporter.hdr}</p>
                <Segmented
                  label={t.exporter.hdr}
                  value={hdr}
                  onChange={setHdr}
                  options={[
                    { value: 'keep', label: t.exporter.hdrKeep },
                    { value: 'sdr', label: t.exporter.hdrSdr },
                  ]}
                />
                <p className="mt-1 text-[12px] text-fg-subtle">{t.exporter.hdrHint}</p>
              </div>
            ) : null}
            <div>
              <p className="mb-1.5 text-[13px] font-medium">{t.exporter.range}</p>
              <Segmented
                label={t.exporter.range}
                value={hasSelection ? range : 'all'}
                onChange={setRange}
                options={[
                  { value: 'all', label: t.exporter.rangeAll },
                  ...(hasSelection ? [{ value: 'selection' as const, label: t.exporter.rangeSelection }] : []),
                ]}
              />
            </div>
          </div>
          <div className="space-y-1 text-[13px] text-fg-muted">
            {size ? (
              <p className="tabular">
                {size.width} × {size.height}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" onClick={start} loading={busy} data-testid="start-export">
            {t.exporter.start}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Where the export is, and what to do with it: download (and where the file goes), watch it, or find it later. */
export function ExportStatus({ items, onClear }: { items: ExportRow[]; onClear: (id: string) => void }) {
  const { t, f } = useI18n();
  if (!items.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
      {items.map((e) => (
        <div key={e.id} className="rounded-md border border-border bg-surface-raised p-3 shadow-md" data-testid="export-status">
          <div className="flex items-start gap-3">
            {e.status === 'succeeded' ? <Birdie mood="cheer" size={40} /> : e.status === 'failed' ? <Birdie mood="confused" size={40} /> : null}
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">
                {e.status === 'succeeded'
                  ? t.exporter.ready
                  : e.status === 'failed'
                    ? t.exporter.failed
                    : e.status === 'queued'
                      ? t.exporter.queued
                      : f(t.exporter.running, { pct: Math.round(e.progress * 100) })}
              </p>
              {e.status === 'failed' && e.error ? <p className="line-clamp-2 text-[12px] text-fg-muted">{e.error}</p> : null}
              {e.status === 'queued' || e.status === 'running' ? <p className="text-[12px] text-fg-muted">{t.exporter.notify}</p> : null}
              {e.status === 'succeeded' ? (
                <p className="text-[12px] text-fg-muted" data-testid="export-saved-to">
                  {f(t.exporter.savedTo, { file: exportFileName(e.projectName) })}
                </p>
              ) : null}
            </div>
            {e.status === 'queued' || e.status === 'running' ? (
              <Button size="sm" variant="ghost" onClick={() => e.jobId && void api(`/jobs/${e.jobId}/cancel`, { method: 'POST' }).catch(() => undefined)}>
                {t.common.cancel}
              </Button>
            ) : (
              <Button size="iconSm" variant="ghost" aria-label={t.common.close} onClick={() => onClear(e.id)}>
                <X />
              </Button>
            )}
          </div>
          {e.status === 'queued' || e.status === 'running' ? (
            <ProgressBar className="mt-2" value={e.status === 'queued' ? null : e.progress} label={t.jobs.export} />
          ) : null}
          {e.status === 'succeeded' && e.url ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="primary">
                <a href={e.url} download>
                  <Download />
                  {t.exporter.download}
                </a>
              </Button>
              {e.previewUrl ? (
                <Button asChild size="sm" variant="secondary">
                  <a href={e.previewUrl} target="_blank" rel="noreferrer">
                    <Play />
                    {t.exporter.play}
                  </a>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="ghost">
                <Link href="/app/exports">
                  <FolderOpen />
                  {t.exporter.allVideos}
                </Link>
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The name the browser saves a download under (the API names it after the project). */
export function exportFileName(projectName: string | undefined): string {
  return `${(projectName || 'open-golf-tracer').trim().slice(0, 60)}.mp4`;
}

interface VersionRow {
  id: string;
  docVersion: number;
  label: string;
  auto: boolean;
  createdAt: string;
  shots: number;
  layers: number;
}

export function VersionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, f, locale } = useI18n();
  const projectId = useEditor((s) => s.projectId);
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [label, setLabel] = useState('');
  const load = () =>
    api<{ versions: VersionRow[] }>(`/projects/${projectId}/versions`).then(
      (r) => setRows(r.versions),
      () => setRows([]),
    );
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  async function saveNamed() {
    await saveNow(true);
    await api(`/projects/${projectId}/versions`, { body: { label } });
    setLabel('');
    void load();
  }
  async function restore(id: string) {
    if (!confirm(t.versions.restoreConfirm)) return;
    await saveNow(true);
    const r = await api<{ docVersion: number; document: unknown }>(`/projects/${projectId}/versions/${id}/restore`, { method: 'POST' });
    useEditor.setState({
      doc: migrateProject(r.document),
      docVersion: r.docVersion,
      saveState: 'saved',
      past: [],
      future: [],
      revision: useEditor.getState().revision + 1,
      selection: null,
    });
    toast.success(t.versions.restored);
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t.versions.title} description={t.versions.lead} wide closeLabel={t.common.close}>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveNamed();
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t.versions.namePlaceholder}
            aria-label={t.versions.namePlaceholder}
            maxLength={120}
          />
          <Button type="submit" variant="secondary">
            {t.versions.saveNamed}
          </Button>
        </form>
        <ul className="mt-4 max-h-80 divide-y divide-border overflow-auto rounded-md border border-border">
          {rows?.map((v) => (
            <li key={v.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <History className="size-4 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{v.label || (v.auto ? t.versions.auto : '—')}</p>
                <p className="text-[12px] text-fg-muted">
                  {relativeTime(v.createdAt, locale)} · {f(t.versions.items, { shots: v.shots, layers: v.layers })}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void restore(v.id)}>
                <RotateCcw />
                {t.versions.restore}
              </Button>
            </li>
          ))}
          {rows && !rows.length ? <li className="px-3 py-6 text-center text-sm text-fg-muted">—</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const mod = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const groups: [string, [string[], string][]][] = [
    [
      t.shortcuts.playback,
      [
        [['Space'], t.shortcuts.items.play],
        [['J', 'K', 'L'], t.shortcuts.items.jkl],
        [['←', '→'], t.shortcuts.items.frame],
        [['Shift', '←/→'], t.shortcuts.items.second],
        [['I', 'O'], t.shortcuts.items.inOut],
        [['[', ']'], t.shortcuts.items.nextShot],
        [['↑', '↓'], t.shortcuts.items.cuts],
        [[mod, '+/−'], t.shortcuts.items.zoom],
        [['\\'], t.shortcuts.items.fit],
      ],
    ],
    [
      t.shortcuts.editing,
      [
        [['S'], t.shortcuts.items.split],
        [['Q', 'W'], t.shortcuts.items.trimTo],
        [['⌫'], t.shortcuts.items.delete],
        [['Alt', '←/→'], t.shortcuts.items.reorder],
        [['Shift', 'click'], t.shortcuts.items.multi],
        [['Alt'], t.shortcuts.items.noSnap],
        [[mod, 'Z'], t.shortcuts.items.undo],
        [[mod, 'Shift', 'Z'], t.shortcuts.items.redo],
        [[mod, 'D'], t.shortcuts.items.duplicate],
        [['↑↓←→'], t.shortcuts.items.nudge],
        [['?'], t.shortcuts.items.help],
      ],
    ],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t.shortcuts.title} wide closeLabel={t.common.close}>
        <div className="grid gap-6 sm:grid-cols-2">
          {groups.map(([title, items]) => (
            <div key={title}>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-fg-muted">{title}</h3>
              <dl className="space-y-2">
                {items.map(([keys, label]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-[13px]">
                    <dt>{label}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The first-run tour. It ends in the main action: with shots found, its last button makes the video. */
export function Onboarding({ onDone, onMake }: { onDone: () => void; onMake?: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const canMake = useEditor((s) => s.doc.shots.some((x) => x.visible));
  const steps = t.onboarding.steps;
  const moods = ['wave', 'point', 'think', 'cheer'] as const;
  const last = step === steps.length - 1;
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent title={steps[step].title} closeLabel={t.common.skip}>
        <div className="flex items-start gap-4" data-testid="onboarding">
          <Birdie mood={moods[step % moods.length]} size={88} className="shrink-0" />
          <p className="text-sm leading-6 text-fg-muted">{steps[step].body}</p>
        </div>
        <div className="mt-5 flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {steps.map((_, i) => (
              <span key={i} className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-accent' : 'w-1.5 bg-border-strong')} />
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onDone}>
              {last && onMake && canMake ? t.onboarding.finish : t.common.skip}
            </Button>
            {last && onMake && canMake ? (
              <Button variant="primary" onClick={onMake} data-testid="onboarding-make">
                <Sparkles />
                {t.onboarding.makeFirst}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => (last ? onDone() : setStep(step + 1))}>
                {last ? t.onboarding.finish : t.common.next}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
