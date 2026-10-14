'use client';

import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Eye,
  EyeOff,
  Flag,
  Image as ImageIcon,
  Lock,
  Map as MapIcon,
  MapPin,
  Music,
  Plus,
  Shapes,
  Type,
  Upload,
  UserSquare2,
  Wand2,
  Crosshair,
} from 'lucide-react';
import { TEMPLATES } from '@golf/render';
import { shotStats } from '@golf/render';
import type { LayerType, Shot } from '@golf/schema';
import { useRef, useState } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Badge, ProgressBar } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n/client';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/cn';
import { M_TO_YD } from '@golf/schema';
import { placeTitle } from './course';
import * as ops from './ops';
import { useEditor, type MediaInfo } from './store';

export function ShotsPanel() {
  const { t, f } = useI18n();
  const shots = useEditor((s) => s.doc.shots);
  const units = useEditor((s) => s.doc.units);
  const selection = useEditor((s) => s.selection);
  const analysis = useEditor((s) => s.analysis);
  const retracking = useEditor((s) => s.retracking);
  const tool = useEditor((s) => s.tool);
  const hidden = shots.filter((s) => !s.visible);
  const hiddenOpen = hidden.length === shots.length || (selection?.kind === 'shot' && hidden.some((s) => s.id === selection.id));

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="shots-panel">
      {analysis.running ? (
        <div className="rounded-md border border-border bg-surface-raised p-3" role="status">
          <div className="flex items-center gap-2.5">
            <Birdie mood="think" size={40} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{t.mascot.thinking}</p>
              <p className="truncate text-[12px] text-fg-muted">{analysis.message || t.editor.analysisRunning}</p>
            </div>
          </div>
          <ProgressBar className="mt-2.5" value={analysis.progress || null} label={t.jobs.analyze} />
        </div>
      ) : null}

      {shots.length === 0 && !analysis.running ? (
        <div className="flex flex-col items-center rounded-md border border-dashed border-border-strong px-4 py-8 text-center">
          <Birdie mood="confused" size={64} />
          <p className="mt-2 text-[13px] text-fg-muted">{t.shots.emptyDone}</p>
        </div>
      ) : null}

      <ul className="flex flex-col gap-1.5" aria-label={t.shots.title}>
        {shots.map((s, i) =>
          s.visible ? (
            <ShotRow
              key={s.id}
              shot={s}
              n={i + 1}
              selected={selection?.kind === 'shot' && selection.id === s.id}
              units={units}
              retracking={!!retracking[s.id]}
            />
          ) : null,
        )}
      </ul>
      {hidden.length ? (
        // Short-game shots and doubtful candidates: out of the way, but one click from use.
        <details className="group rounded-md" open={hiddenOpen}>
          <summary className="cursor-pointer select-none px-1 text-[12px] font-medium text-fg-muted hover:text-fg">
            {f(t.shots.hiddenShots, { n: hidden.length })}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {shots.map((s, i) =>
              s.visible ? null : (
                <ShotRow
                  key={s.id}
                  shot={s}
                  n={i + 1}
                  selected={selection?.kind === 'shot' && selection.id === s.id}
                  units={units}
                  retracking={!!retracking[s.id]}
                />
              ),
            )}
          </ul>
        </details>
      ) : null}

      {shots.filter((s) => s.visible && s.kind === 'full').length ? <ShortsButton /> : null}
      <Button
        variant={tool === 'addShot' ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => useEditor.getState().setTool(tool === 'addShot' ? 'select' : 'addShot')}
        aria-pressed={tool === 'addShot'}
      >
        <Crosshair />
        {t.shots.addManual}
      </Button>
      <p className="text-[12px] text-fg-subtle">{t.shots.addManualHint}</p>
      <span className="sr-only" aria-live="polite">
        {f(t.editor.analysisFound, { n: shots.length })}
      </span>
    </div>
  );
}

/** One place to make videos: the "Make video" dialog (YouTube, highlight short, a short per shot). */
function ShortsButton() {
  const { t } = useI18n();
  return (
    <Button variant="primary" size="sm" onClick={() => useEditor.setState({ makeOpen: true })} data-testid="shots-make">
      <Wand2 />
      {t.make.open}
    </Button>
  );
}

function ShotRow({ shot, n, selected, units, retracking }: { shot: Shot; n: number; selected: boolean; units: 'm' | 'yd'; retracking: boolean }) {
  const { t, f, locale } = useI18n();
  const st = shotStats(shot);
  const carry = st ? (units === 'yd' ? `${Math.round(st.carryM * M_TO_YD)} yd` : `${Math.round(st.carryM)} m`) : '–';
  const place = useEditor((s) => s.doc.media[shot.mediaId]?.place ?? null);
  const hole = place?.hole ? placeTitle({ ...place, par: null }, locale) : '';
  const check = shot.confidence < 0.6 || shot.warnings.some((w) => w.code !== 'manual' && w.code !== 'low_confidence');
  const firstWarning = shot.warnings.find((w) => w.code !== 'low_confidence') ?? shot.warnings[0];
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => ops.jumpToShot(shot)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ops.jumpToShot(shot))}
        className={cn(
          'group flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors',
          selected ? 'border-red-500/70 bg-red-500/10' : 'border-transparent hover:bg-surface-sunken',
          !shot.visible && 'opacity-60',
        )}
      >
        <span
          className="size-3 shrink-0 rounded-full"
          style={{ background: shot.style.color2 ? `linear-gradient(135deg, ${shot.style.color}, ${shot.style.color2})` : shot.style.color }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{shot.label || f(t.shots.shot, { n })}</span>
            {shot.kind === 'short' ? <Badge>{t.shots.shortShot}</Badge> : null}
            {shot.source === 'manual' ? <Badge>{t.shots.warnings.manual.replace('.', '')}</Badge> : null}
          </div>
          <p className="tabular text-[12px] text-fg-muted">
            {carry}
            {shot.constraints.carry == null ? <span className="text-fg-subtle"> · {t.tracer.estimate.toLowerCase()}</span> : null}
            {hole ? <span className="text-fg-subtle"> · {hole}</span> : null}
            {retracking ? ` · ${t.shots.retracking}` : ''}
          </p>
          {check ? (
            <Tooltip label={firstWarning ? ((t.shots.warnings as Record<string, string>)[firstWarning.code] ?? '') : t.shots.warnings.low_confidence}>
              <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-warning">
                <AlertTriangle className="size-3" aria-hidden />
                {t.shots.checkThis}
                <span className="sr-only">: {firstWarning ? (t.shots.warnings as Record<string, string>)[firstWarning.code] : ''}</span>
              </span>
            </Tooltip>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded-sm p-1 text-fg-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 aria-[pressed=false]:opacity-100"
          aria-pressed={shot.visible}
          aria-label={shot.visible ? t.shots.hide : t.shots.show}
          onClick={(e) => {
            e.stopPropagation();
            ops.setShotVisible(shot.id, !shot.visible);
          }}
        >
          {shot.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </button>
      </div>
    </li>
  );
}

const LAYER_ICONS: Record<LayerType, typeof Type> = {
  text: Type,
  statCard: BarChart3,
  shape: Shapes,
  arrow: ArrowUpRight,
  image: ImageIcon,
  lowerThird: UserSquare2,
  holeInfo: Flag,
  distance: MapPin,
  courseMap: MapIcon,
};

/** Course maps are made from a shot ("Measure on the map"), not from the add menu. */
const ADDABLE = (Object.keys(LAYER_ICONS) as LayerType[]).filter((x) => x !== 'courseMap');

export function AddLayerMenu({ compact }: { compact?: boolean }) {
  const { t, locale } = useI18n();
  const imageInput = useRef<HTMLInputElement>(null);
  function add(type: LayerType) {
    if (type === 'image') return imageInput.current?.click();
    const s = useEditor.getState();
    const layer = ops.layerDefaults(
      type,
      {
        ...t.layers.types,
        textDefault: t.layers.defaults.text,
        lowerThirdDefault: t.layers.defaults.lowerThird,
        lowerThirdSub: t.layers.defaults.lowerThirdSub,
        distanceLabel: t.layers.defaults.distanceLabel,
      },
      s.doc,
      s.time,
      locale,
    );
    ops.addLayer(layer);
  }
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="secondary" size="sm" className={compact ? '' : 'w-full'}>
            <Plus />
            {t.layers.add}
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          {ADDABLE.map((type) => {
            const Icon = LAYER_ICONS[type];
            return (
              <MenuItem key={type} icon={<Icon />} onSelect={() => add(type)}>
                {t.layers.types[type]}
              </MenuItem>
            );
          })}
        </MenuContent>
      </Menu>
      <ImageUpload inputRef={imageInput} />
    </>
  );
}

function ImageUpload({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const { t } = useI18n();
  const projectId = useEditor((s) => s.projectId);
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
          const res = await uploadFile(file, { projectId, kind: 'image' });
          const m = res.media as unknown as MediaInfo;
          useEditor.getState().setMedia(m);
          ops.addImageMedia(m);
          const s = useEditor.getState();
          const layer = ops.layerDefaults('image', t.layers.types as unknown as Record<string, string>, s.doc, s.time);
          if (layer.type === 'image') layer.props.mediaId = m.id;
          ops.addLayer(layer);
        } catch (err) {
          toast.error(t.upload.failed, errorMessage(err, t));
        }
      }}
    />
  );
}

export function LayersPanel() {
  const { t } = useI18n();
  const layers = useEditor((s) => s.doc.layers);
  const selection = useEditor((s) => s.selection);
  const sel = selection?.kind === 'layer' ? selection.ids : [];
  return (
    <div className="flex flex-col gap-3 p-3">
      <AddLayerMenu />
      {layers.length === 0 ? (
        <p className="rounded-md border border-dashed border-border-strong px-4 py-6 text-center text-[13px] text-fg-muted">{t.layers.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={t.layers.title}>
          {[...layers].reverse().map((l) => {
            const Icon = LAYER_ICONS[l.type];
            const selected = sel.includes(l.id);
            return (
              <li key={l.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={(e) => useEditor.getState().select({ kind: 'layer', ids: e.shiftKey ? Array.from(new Set([...sel, l.id])) : [l.id] })}
                  onKeyDown={(e) => e.key === 'Enter' && useEditor.getState().select({ kind: 'layer', ids: [l.id] })}
                  className={cn(
                    'group flex items-center gap-2 rounded-md border px-2 py-1.5 text-[13px]',
                    selected ? 'border-red-500/70 bg-red-500/10' : 'border-transparent hover:bg-surface-sunken',
                    l.hidden && 'opacity-50',
                  )}
                >
                  <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{l.name && l.name !== l.type ? l.name : t.layers.types[l.type]}</span>
                  {l.locked ? <Lock className="size-3.5 text-fg-subtle" aria-label={t.layers.lock} /> : null}
                  <button
                    type="button"
                    className="rounded-sm p-0.5 text-fg-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={l.hidden ? t.layers.show : t.layers.hide}
                    onClick={(e) => {
                      e.stopPropagation();
                      ops.updateLayer(l.id, (x) => {
                        x.hidden = !x.hidden;
                      });
                    }}
                  >
                    {l.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function TemplatesPanel() {
  const { t, f, locale } = useI18n();
  const [last, setLast] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-[13px] text-fg-muted">{t.templates.lead}</p>
      <ul className="flex flex-col gap-2">
        {TEMPLATES.map((tpl) => {
          return (
            <li key={tpl.id} className={cn('rounded-md border p-3', last === tpl.id ? 'border-red-500/70' : 'border-border')}>
              <div className="flex items-center gap-2">
                <span
                  className="size-3 rounded-full"
                  style={{ background: tpl.style.color2 ? `linear-gradient(135deg, ${tpl.style.color}, ${tpl.style.color2})` : tpl.style.color }}
                  aria-hidden
                />
                <span className="flex-1 text-[13px] font-medium">{tpl.name[locale]}</span>
              </div>
              <p className="mt-1 text-[12px] text-fg-muted">{tpl.description[locale]}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  ops.applyProjectTemplate(tpl.id, locale);
                  setLast(tpl.id);
                  toast.success(f(t.templates.applied, { name: tpl.name[locale] }));
                }}
              >
                <Wand2 />
                {t.templates.apply}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function MediaPanel() {
  const { t } = useI18n();
  const projectId = useEditor((s) => s.projectId);
  const media = useEditor((s) => s.media);
  const input = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(0);
  const items = Object.values(media);
  return (
    <div className="flex flex-col gap-3 p-3">
      <Button variant="secondary" size="sm" loading={videoBusy > 0} onClick={() => videoInput.current?.click()}>
        <Plus />
        {t.media.addVideos}
      </Button>
      <p className="text-[12px] text-fg-subtle">{t.media.addVideosHint}</p>
      <input
        ref={videoInput}
        type="file"
        accept="video/*,.mov,.mp4,.m4v,.mkv"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          // Each clip joins the timeline (in filming order) once its preview is ready.
          await Promise.all(
            files.map(async (file) => {
              setVideoBusy((n) => n + 1);
              try {
                await uploadFile(file, { projectId, kind: 'video' });
              } catch (err) {
                toast.error(t.upload.failed, errorMessage(err, t));
              } finally {
                setVideoBusy((n) => n - 1);
              }
            }),
          );
        }}
      />
      <Button variant="secondary" size="sm" loading={busy} onClick={() => input.current?.click()}>
        <Upload />
        {t.audio.addMusic}
      </Button>
      <p className="text-[12px] text-fg-subtle">{t.audio.musicHint}</p>
      <input
        ref={input}
        type="file"
        accept="audio/*,.mp3,.m4a,.wav"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          try {
            const res = await uploadFile(file, { projectId, kind: 'audio' });
            const m = res.media as unknown as MediaInfo;
            useEditor.getState().setMedia(m);
            ops.addMusic(m);
          } catch (err) {
            toast.error(t.upload.failed, errorMessage(err, t));
          } finally {
            setBusy(false);
          }
        }}
      />
      <ul className="flex flex-col gap-1">
        {items.map((m) => (
          <li key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
            {m.kind === 'audio' ? (
              <Music className="size-4 text-fg-muted" />
            ) : m.kind === 'image' ? (
              <ImageIcon className="size-4 text-fg-muted" />
            ) : (
              <Shapes className="size-4 text-fg-muted" />
            )}
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
            {m.status === 'processing' ? <Badge>{t.jobs.ingest}</Badge> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
