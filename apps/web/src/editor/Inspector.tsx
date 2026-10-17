'use client';

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Crosshair,
  Diamond,
  Lock,
  LockOpen,
  Map as MapIcon,
  Maximize2,
  Minus,
  PenLine,
  Plus,
  RotateCcw,
  Save,
  ScanSearch,
  Trash2,
  Unlink,
  Wand2,
} from 'lucide-react';
import { FONTS, layerEnv, measureLayer, shotStats } from '@golf/render';
import {
  M_TO_YD,
  MPS_TO_MPH,
  TRACER_PRESETS,
  TRACER_PRESET_IDS,
  clipAt,
  primaryMedia,
  timelineDuration,
  toMetres,
  type AnimPreset,
  type Club,
  type Easing,
  type FontId,
  type Layer,
  type LayerOf,
  type Shot,
  type StatField,
  type TracerStyle,
} from '@golf/schema';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ColorField, NumberField, Segmented, Select, Slider, Switch } from '@/components/ui/controls';
import { Input, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { api, errorMessage } from '@/lib/api';
import type { Dict } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import { placeTitle } from './course';
import { MapDialog } from './MapDialog';
import * as ops from './ops';
import { shotList, shotName } from './shotGroups';
import { useEditor, useLiveDoc } from './store';

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.04em] text-fg-muted">{title}</h3>
        {action}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({ label, children, value }: { label: string; children: ReactNode; value?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-medium text-fg">{label}</span>
        {value != null ? <span className="tabular text-fg-muted">{value}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between text-[13px]">
      {label}
      <Switch checked={checked} onChange={onChange} label={label} />
    </label>
  );
}

/** The sub-inspectors are memoised: this re-renders on every document change, they only when
 *  their own shot, layer or clip does. */
export function Inspector({ onRetrack }: { onRetrack: (shot: Shot) => void }) {
  const selection = useEditor((s) => s.selection);
  const doc = useLiveDoc();
  if (selection?.kind === 'shot') {
    const shot = doc.shots.find((s) => s.id === selection.id);
    if (shot) return shot.kind === 'putt' ? <PuttInspector shot={shot} /> : <ShotInspector shot={shot} onRetrack={onRetrack} />;
  }
  if (selection?.kind === 'layer') {
    const ls = doc.layers.filter((l) => selection.ids.includes(l.id));
    if (ls.length === 1) return <LayerInspector layer={ls[0]} />;
    if (ls.length > 1) return <MultiLayerInspector ids={ls.map((l) => l.id)} />;
  }
  if (selection?.kind === 'clip') {
    const c = doc.clips.find((x) => x.id === selection.id);
    if (c) return <ClipInspector id={c.id} />;
  }
  if (selection?.kind === 'audio') {
    const a = doc.audioTracks.find((x) => x.id === selection.id);
    if (a) return <AudioInspector id={a.id} />;
  }
  return <ProjectInspector />;
}

// ---------------------------------------------------------------------------------------------
// Shot / tracer

/** The shot's doubts, and "Looks right" to settle them (they stay settled, one undo step). */
function ShotWarnings({ shot }: { shot: Shot }) {
  const { t } = useI18n();
  const doubts = shot.warnings.filter((w) => w.code !== 'manual');
  if (!doubts.length && shot.confidence >= 0.6) return null;
  const text = t.shots.warnings as Record<string, string>;
  return (
    <div
      className="flex flex-col gap-2 border-b border-border bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-4 py-3 text-[12px] text-fg"
      data-testid="shot-warnings"
    >
      {doubts.length ? doubts.map((w) => <p key={w.code}>{text[w.code]}</p>) : <p>{text.low_confidence}</p>}
      <div>
        <Button size="sm" variant="secondary" onClick={() => ops.approveShot(shot.id)} data-testid="shot-approve">
          <Check />
          {t.shots.looksRight}
        </Button>
      </div>
    </div>
  );
}

/** Putt, short shot or full shot: the analysis can mistake one for another. */
function ShotKind({ shot }: { shot: Shot }) {
  const { t } = useI18n();
  return (
    <Row label={t.shots.kindLabel}>
      <Segmented
        label={t.shots.kindLabel}
        size="sm"
        value={shot.kind}
        onChange={(v) => ops.setShotKind(shot.id, v)}
        options={(['putt', 'short', 'full'] as const).map((k) => ({ value: k, label: t.shots.kinds[k] }))}
      />
    </Row>
  );
}

/** The number the shot list shows for a shot (within its hole in a round), 0 when hidden. */
function useShotNumber(id: string): number {
  const shots = useEditor((s) => s.doc.shots);
  const media = useEditor((s) => s.doc.media);
  return useMemo(() => shotList({ shots, media }).numbers.get(id) ?? 0, [shots, media, id]);
}

const PuttInspector = memo(function PuttInspector({ shot }: { shot: Shot }) {
  const { t, f } = useI18n();
  const holed = shot.putt?.holed ?? null;
  const value = holed === null ? 'unknown' : holed ? 'yes' : 'no';
  return (
    <div className="flex flex-col" data-testid="putt-inspector">
      <ShotWarnings shot={shot} />
      <Section title={t.shots.putt}>
        <ShotKind shot={shot} />
        <p className="text-[12px] text-fg-muted">{t.shots.puttLead}</p>
        {shot.putt ? (
          <p className="tabular text-[12px] text-fg-muted">{f(t.shots.puttRoll, { s: Math.max(0, shot.putt.end - shot.impactTime).toFixed(1) })}</p>
        ) : null}
        <p className="text-[12px] font-medium">{t.shots.puttHoledLabel}</p>
        <Segmented
          label={t.shots.puttHoledLabel}
          value={value}
          onChange={(v) => ops.setPuttHoled(shot.id, v === 'unknown' ? null : v === 'yes')}
          options={[
            { value: 'yes', label: t.shots.puttHoledYes },
            { value: 'no', label: t.shots.puttHoledNo },
            { value: 'unknown', label: t.shots.puttHoledUnknown },
          ]}
        />
        {shot.putt?.path?.length ? (
          <>
            <Toggle label={t.shots.puttLine} checked={!!shot.putt.line} onChange={(v) => ops.setPuttLine(shot.id, v)} />
            <p className="text-[12px] text-fg-muted">{t.shots.puttLineHint}</p>
            {shot.putt.line ? (
              <Row label={t.tracer.color}>
                <ColorField
                  label={t.tracer.color}
                  value={shot.style.color}
                  onChange={(c) => ops.setShotStyle(shot.id, { color: c, color2: null, preset: 'custom' }, 'color')}
                />
              </Row>
            ) : null}
          </>
        ) : (
          <p className="text-[12px] text-fg-muted">{t.shots.puttLineNone}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" className="text-accent-fg" onClick={() => ops.deleteShot(shot.id)}>
            <Trash2 />
            {t.shots.delete}
          </Button>
        </div>
      </Section>
    </div>
  );
});

const CLUB_OPTIONS: Club[] = ['auto', 'driver', 'wood', 'longIron', 'midIron', 'shortIron', 'wedge'];

const ShotInspector = memo(function ShotInspector({ shot, onRetrack }: { shot: Shot; onRetrack: (shot: Shot) => void }) {
  const { t, f, locale } = useI18n();
  const units = useEditor((s) => s.doc.units);
  const tool = useEditor((s) => s.tool);
  const retracking = useEditor((s) => !!s.retracking[shot.id]);
  const st = shotStats(shot);
  const n = useShotNumber(shot.id);
  const carryVal = shot.constraints.carry != null ? (units === 'yd' ? shot.constraints.carry * M_TO_YD : shot.constraints.carry) : null;
  const measured = shot.constraints.carry != null;
  const fps = ops.fpsOf(shot.mediaId);
  const style = shot.style;
  const setStyle = (p: Partial<TracerStyle>, key?: string) => ops.setShotStyle(shot.id, { ...p, preset: 'custom' }, key);
  const [mapOpen, setMapOpen] = useState(false);
  const place = useEditor((s) => s.doc.media[shot.mediaId]?.place ?? null);
  // Handles the preview cannot show (outside the picture or the 9:16 crop).
  const crop = useEditor((s) => s.doc.format);
  const outside = useMemo(() => (shot.kind === 'putt' ? [] : ops.handlesOutside(shot)), [shot, crop]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleDraw = () => {
    const s = useEditor.getState();
    if (s.tool === 'drawPath') return s.setTool('select');
    // Drawing needs the shot on screen: go to just before its launch unless its video is showing.
    if (clipAt(s.doc.clips, s.time)?.clip.mediaId !== shot.mediaId) ops.jumpToShot(shot);
    s.setTool('drawPath');
  };
  const intoView = () => {
    if (ops.bringIntoView(shot.id)) toast.success(t.tracer.intoViewDone);
  };

  const fmt = (field: StatField) => {
    if (!st) return '–';
    const d = (m: number) => (units === 'yd' ? `${Math.round(m * M_TO_YD)} yd` : `${Math.round(m)} m`);
    switch (field) {
      case 'carry':
        return d(st.carryM);
      case 'apex':
        return d(st.apexM);
      case 'ballSpeed':
        return `${Math.round(st.ballSpeedMps * MPS_TO_MPH)} mph`;
      case 'launch':
        return `${st.launchAngleDeg.toFixed(1)}°`;
      case 'flightTime':
        return `${st.flightTimeS.toFixed(1)} s`;
      case 'curve':
        return `${d(Math.abs(st.curveM))} ${st.curveM >= 0 ? (locale === 'da' ? 'H' : 'R') : locale === 'da' ? 'V' : 'L'}`;
    }
  };

  return (
    <div data-testid="shot-inspector">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Input
          aria-label={t.common.rename}
          className="h-8 text-[13px] font-medium"
          value={shot.label}
          placeholder={shotName({ ...shot, label: '' }, n, t)}
          onChange={(e) =>
            useEditor.getState().edit(
              'Name',
              (d) => {
                const s = d.shots.find((x) => x.id === shot.id);
                if (s) s.label = e.target.value.slice(0, 80);
              },
              { key: `label:${shot.id}` },
            )
          }
        />
      </div>
      <ShotWarnings shot={shot} />

      <Section title={t.tracer.section}>
        <ShotKind shot={shot} />
        {outside.length ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-[color-mix(in_srgb,var(--color-warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] p-3"
            data-testid="offview-notice"
          >
            <p className="text-[12px] text-fg">{t.tracer.offView}</p>
            <Button size="sm" variant="primary" onClick={intoView}>
              <Maximize2 />
              {t.tracer.intoView}
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-fg-muted">{t.tracer.editOnVideo}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={tool === 'drawPath' ? 'primary' : 'secondary'} aria-pressed={tool === 'drawPath'} onClick={toggleDraw}>
            <PenLine />
            {t.tracer.draw}
          </Button>
          <Button
            size="sm"
            variant={tool === 'addPoint' ? 'primary' : 'secondary'}
            onClick={() => useEditor.getState().setTool(tool === 'addPoint' ? 'select' : 'addPoint')}
          >
            <Crosshair />
            {t.tracer.addPoint}
          </Button>
          {shot.constraints.points.length ? (
            <Button size="sm" variant="ghost" onClick={() => void ops.setConstraint(shot.id, { points: [] })}>
              <Unlink />
              {t.tracer.removePoint} ({shot.constraints.points.length})
            </Button>
          ) : null}
        </div>
        {tool === 'drawPath' ? <p className="text-[12px] text-fg-muted">{t.tracer.drawHint}</p> : null}
        <div className="flex flex-wrap gap-2">
          {!outside.length ? (
            <Button size="sm" variant="ghost" onClick={intoView}>
              <Maximize2 />
              {t.tracer.intoView}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => ops.resetShot(shot.id) === 'inView' && toast.info(t.tracer.resetInView)}>
            <RotateCcw />
            {t.shots.reset}
          </Button>
          <Button size="sm" variant="ghost" loading={retracking} onClick={() => onRetrack(shot)}>
            <ScanSearch />
            {t.shots.retrack}
          </Button>
          <Button size="sm" variant="ghost" className="text-accent-fg" onClick={() => ops.deleteShot(shot.id)}>
            <Trash2 />
            {t.shots.delete}
          </Button>
        </div>
      </Section>

      <Section title={t.tracer.carry}>
        {place?.course ? (
          <p className="text-[12px] text-fg-muted" data-testid="shot-place">
            {[
              place.course,
              placeTitle(place, locale) !== place.course ? placeTitle(place, locale) : '',
              place.toGreen != null ? f(t.map.toGreen, { m: Math.round(place.toGreen) }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        <Row label={t.tracer.club}>
          <Select
            label={t.tracer.club}
            size="sm"
            value={shot.club}
            onChange={(v) => void ops.setClub(shot.id, v as Club)}
            options={CLUB_OPTIONS.map((c) => ({ value: c, label: t.tracer.clubs[c] }))}
          />
        </Row>
        {shot.club === 'auto' && !measured ? <p className="text-[12px] text-fg-muted">{t.tracer.clubHint}</p> : null}
        <div className="flex flex-col gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setMapOpen(true)}>
            <MapIcon />
            {t.map.open}
          </Button>
          <p className="text-[12px] text-fg-muted">{shot.geo ? `${t.map.measured}: ${Math.round(shot.constraints.carry ?? 0)} m` : t.map.openHint}</p>
        </div>
        {mapOpen ? <MapDialog shot={shot} open={mapOpen} onOpenChange={setMapOpen} /> : null}
        <div className="flex items-center gap-2">
          <NumberField
            label={t.tracer.carry}
            value={carryVal == null ? null : Math.round(carryVal)}
            nullable
            min={1}
            max={500}
            unit={units}
            placeholder={t.tracer.carryPlaceholder}
            className="w-32"
            onChange={(v) => void ops.setConstraint(shot.id, { carry: v == null ? null : toMetres(v, units) })}
          />
          <Badge tone={measured ? 'success' : 'warning'}>{measured ? t.tracer.measured : t.tracer.estimate}</Badge>
        </div>
        <p className="text-[12px] text-fg-muted">{measured ? t.tracer.carryHint : t.tracer.noNumbers}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-surface-sunken p-3">
          {(['carry', 'apex', 'ballSpeed', 'launch', 'flightTime', 'curve'] as StatField[]).map((k) => (
            <div key={k}>
              <dt className="text-[11px] text-fg-muted">{t.tracer.stats[k]}</dt>
              <dd className="tabular text-[14px] font-semibold">
                {fmt(k)}
                {!measured && k !== 'flightTime' && k !== 'launch' ? <span className="text-fg-subtle">*</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title={t.tracer.shape}>
        <Segmented
          label={t.tracer.shape}
          size="sm"
          value={shot.constraints.curve == null ? 'auto' : shot.constraints.curve < -0.15 ? 'draw' : shot.constraints.curve > 0.15 ? 'fade' : 'straight'}
          onChange={(v) => void ops.setConstraint(shot.id, { curve: v === 'auto' ? null : v === 'draw' ? -0.5 : v === 'fade' ? 0.5 : 0 })}
          options={[
            { value: 'auto', label: t.tracer.curveAuto },
            { value: 'draw', label: t.tracer.curveDraw },
            { value: 'straight', label: t.tracer.curveStraight },
            { value: 'fade', label: t.tracer.curveFade },
          ]}
        />
        {shot.constraints.curve != null ? (
          <CommitSlider
            label={t.tracer.shape}
            value={shot.constraints.curve}
            min={-1}
            max={1}
            step={0.05}
            onCommit={(v) => void ops.setConstraint(shot.id, { curve: v })}
          />
        ) : null}
        <Row label={t.tracer.flightTime} value={st ? `${st.flightTimeS.toFixed(1)} s` : undefined}>
          <NumberField
            label={t.tracer.flightTime}
            value={shot.constraints.flightTime}
            nullable
            min={0.5}
            max={12}
            step={0.1}
            unit="s"
            placeholder={t.tracer.curveAuto}
            className="w-32"
            onChange={(v) => void ops.setConstraint(shot.id, { flightTime: v })}
          />
        </Row>
      </Section>

      <Section title={t.tracer.timing}>
        <Row label={t.tracer.launch} value={`${shot.timing.launchOffset >= 0 ? '+' : ''}${Math.round(shot.timing.launchOffset * fps)} f`}>
          <div className="flex items-center gap-1.5">
            <Button size="iconSm" variant="secondary" aria-label={t.tracer.prevFrame} onClick={() => ops.nudgeLaunch(shot.id, -1)}>
              <Minus />
            </Button>
            <Button size="iconSm" variant="secondary" aria-label={t.tracer.nextFrame} onClick={() => ops.nudgeLaunch(shot.id, 1)}>
              <Plus />
            </Button>
            <span className="text-[12px] text-fg-subtle">{t.tracer.launchHint}</span>
          </div>
        </Row>
        <Row label={t.tracer.animSpeed} value={`${shot.timing.speed.toFixed(2)}×`}>
          <Slider label={t.tracer.animSpeed} value={shot.timing.speed} min={0.25} max={3} step={0.05} onChange={(v) => ops.setTiming(shot.id, { speed: v })} />
        </Row>
        <Row label={t.tracer.slowmo}>
          <Select
            label={t.tracer.slowmo}
            size="sm"
            value={String(shot.slowmo)}
            onChange={(v) => ops.setSlowmo(shot.id, Number(v))}
            options={slowmoOptions(shot.slowmo, t)}
          />
        </Row>
        <p className="text-[12px] text-fg-muted">{t.tracer.slowmoHint}</p>
      </Section>

      <Section
        title={t.tracer.style}
        action={
          <Button size="sm" variant="link" onClick={() => ops.applyStyleToAll(shot.style)}>
            {t.tracer.applyToAll}
          </Button>
        }
      >
        <div className="grid grid-cols-3 gap-1.5">
          {TRACER_PRESET_IDS.map((p) => {
            const ps = TRACER_PRESETS[p];
            return (
              <button
                key={p}
                type="button"
                aria-pressed={style.preset === p}
                onClick={() => ops.applyPreset(shot.id, p)}
                className="flex flex-col items-center gap-1 rounded-md border border-border px-1 py-2 text-[11px] hover:border-border-strong aria-pressed:border-red-500 aria-pressed:bg-red-500/10"
              >
                <svg viewBox="0 0 40 20" className="h-5 w-10" aria-hidden>
                  <defs>
                    <linearGradient id={`g-${p}`} x1="0" x2="1">
                      <stop offset="0" stopColor={ps.color} />
                      <stop offset="1" stopColor={ps.color2 ?? ps.color} />
                    </linearGradient>
                  </defs>
                  <path d="M2 18 Q 20 -6 38 12" fill="none" stroke={`url(#g-${p})`} strokeWidth={2 * ps.width} strokeLinecap="round" />
                </svg>
                {t.tracer.presets[p]}
              </button>
            );
          })}
        </div>
        <Row label={t.tracer.color}>
          <ColorField label={t.tracer.color} value={style.color} onChange={(c) => setStyle({ color: c }, 'color')} />
        </Row>
        <Toggle label={t.tracer.color2} checked={!!style.color2} onChange={(v) => setStyle({ color2: v ? '#ffc83d' : null })} />
        {style.color2 ? <ColorField label={t.tracer.color2} value={style.color2} onChange={(c) => setStyle({ color2: c }, 'color2')} /> : null}
        <Row label={t.tracer.width} value={`${style.width.toFixed(1)}×`}>
          <Slider label={t.tracer.width} value={style.width} min={0.3} max={8} step={0.05} onChange={(v) => setStyle({ width: v }, 'width')} />
        </Row>
        <Row label={t.tracer.glow} value={`${Math.round(style.glow * 100)} %`}>
          <Slider label={t.tracer.glow} value={style.glow} onChange={(v) => setStyle({ glow: v }, 'glow')} />
        </Row>
        <Row label={t.tracer.perspective} value={`${Math.round(style.perspective * 100)} %`}>
          <Slider label={t.tracer.perspective} value={style.perspective} onChange={(v) => setStyle({ perspective: v }, 'persp')} />
        </Row>
        <Row label={t.tracer.fadeIn} value={`${Math.round(style.fadeIn * 100)} %`}>
          <Slider label={t.tracer.fadeIn} value={style.fadeIn} max={0.6} onChange={(v) => setStyle({ fadeIn: v }, 'fadeIn')} />
        </Row>
        <Row label={t.tracer.core} value={`${Math.round(style.core * 100)} %`}>
          <Slider label={t.tracer.core} value={style.core} onChange={(v) => setStyle({ core: v }, 'core')} />
        </Row>
        <Row label={t.tracer.comet} value={style.comet ? `${style.comet.toFixed(1)} s` : t.common.off}>
          <Slider label={t.tracer.comet} value={style.comet} min={0} max={3} step={0.1} onChange={(v) => setStyle({ comet: v }, 'comet')} />
        </Row>
        <Toggle label={t.tracer.ballHead} checked={style.ballHead} onChange={(v) => setStyle({ ballHead: v })} />
        <Toggle label={t.tracer.landingMarker} checked={style.landingMarker} onChange={(v) => setStyle({ landingMarker: v })} />
        <Toggle label={t.tracer.impactFlash} checked={style.impactFlash} onChange={(v) => setStyle({ impactFlash: v })} />
        <Row label={t.tracer.afterLanding}>
          <Segmented
            label={t.tracer.afterLanding}
            size="sm"
            value={style.afterLanding}
            onChange={(v) => setStyle({ afterLanding: v })}
            options={(['hold', 'fade', 'hide'] as const).map((v) => ({ value: v, label: t.tracer.afterLandingOptions[v] }))}
          />
        </Row>
        {style.afterLanding === 'fade' ? (
          <Row label={t.tracer.fadeSeconds} value={`${style.fadeSeconds.toFixed(1)} s`}>
            <Slider
              label={t.tracer.fadeSeconds}
              value={style.fadeSeconds}
              min={0.2}
              max={6}
              step={0.1}
              onChange={(v) => setStyle({ fadeSeconds: v }, 'fade')}
            />
          </Row>
        ) : null}
        <MyStyles shot={shot} />
      </Section>
    </div>
  );
});

/**
 * Slow motion as the phone puts it: filmed at 120 or 240 fps and played back at 30 or 60. The
 * stored value is the factor (filmed ÷ played back); one the list does not name stays selectable.
 */
const SLOWMO_CHOICES: { factor: number; filmed: number; played: number }[] = [
  { factor: 2, filmed: 120, played: 60 },
  { factor: 4, filmed: 120, played: 30 },
  { factor: 8, filmed: 240, played: 30 },
];

export function slowmoOptions(current: number, t: Dict): { value: string; label: string }[] {
  const opts = [
    { value: '1', label: t.tracer.slowmoNone },
    ...SLOWMO_CHOICES.map((c) => ({
      value: String(c.factor),
      label: t.tracer.slowmoFps.replace('{filmed}', String(c.filmed)).replace('{played}', String(c.played)),
    })),
  ];
  if (!opts.some((o) => o.value === String(current))) opts.push({ value: String(current), label: `${current}×` });
  return opts;
}

/** Slider that applies once on release (for expensive refits). */
function CommitSlider({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <Slider label={label} value={v} min={min} max={max} step={step} onChange={setV} onCommit={onCommit} />;
}

function MyStyles({ shot }: { shot: Shot }) {
  const { t } = useI18n();
  const [styles, setStyles] = useState<{ id: string; name: string; style: TracerStyle }[]>([]);
  const [name, setName] = useState('');
  useEffect(() => {
    api<{ styles: { id: string; name: string; style: TracerStyle }[] }>('/account/styles').then(
      (r) => setStyles(r.styles),
      () => undefined,
    );
  }, []);
  async function save() {
    if (!name.trim()) return;
    try {
      const s = await api<{ id: string; name: string; style: TracerStyle }>('/account/styles', { body: { name, style: shot.style } });
      setStyles((x) => [...x, s]);
      setName('');
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }
  return (
    <div className="mt-1 rounded-md border border-border p-3">
      <p className="mb-2 text-[12px] font-medium">{t.tracer.myStyles}</p>
      {styles.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {styles.map((s) => (
            <span key={s.id} className="group inline-flex items-center rounded-full border border-border-strong text-[12px]">
              <button type="button" className="flex items-center gap-1.5 py-1 pl-2 pr-1" onClick={() => ops.setShotStyle(shot.id, { ...s.style })}>
                <span className="size-2.5 rounded-full" style={{ background: s.style.color }} aria-hidden />
                {s.name}
              </button>
              <button
                type="button"
                aria-label={`${t.common.delete} ${s.name}`}
                className="pr-2 text-fg-subtle hover:text-fg"
                onClick={async () => {
                  await api(`/account/styles/${s.id}`, { method: 'DELETE' }).catch(() => undefined);
                  setStyles((x) => x.filter((y) => y.id !== s.id));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex gap-1.5">
        <Input
          className="h-8 text-[13px]"
          placeholder={t.tracer.styleName}
          aria-label={t.tracer.styleName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
        />
        <Button size="sm" variant="secondary" onClick={save} disabled={!name.trim()}>
          <Save />
          {t.tracer.saveStyle}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Layers

const ANIMS: AnimPreset[] = ['none', 'fade', 'slideUp', 'slideLeft', 'slideRight', 'pop', 'typewriter', 'wipe'];
const EASINGS: Easing[] = ['easeInOut', 'linear', 'easeIn', 'easeOut', 'hold'];

const LayerInspector = memo(function LayerInspector({ layer }: { layer: Layer }) {
  const { t } = useI18n();
  // Only which keyframe is under the playhead matters here, not every playhead tick.
  const keyState = useEditor((s) => layerKeyState(layer, s.time));
  const [curIdx, onIdx] = keyState.split(':').map(Number);
  // Whole seconds: only a field limit (setLayerTiming clamps exactly), so trims do not re-render this.
  const total = useEditor((s) => Math.ceil(timelineDuration(s.doc)));
  const sorted = [...layer.keyframes].sort((a, b) => a.t - b.t);
  const cur = sorted[curIdx] ?? sorted[0];
  const onKey = onIdx >= 0;
  const now = () => useEditor.getState().time;
  const P = (patch: Record<string, unknown>) => ops.updateLayerProps(layer.id, patch);

  return (
    <div data-testid="layer-inspector">
      <div className="flex items-center gap-1 border-b border-border px-4 py-3">
        <Input
          aria-label={t.common.rename}
          className="h-8 flex-1 text-[13px] font-medium"
          value={layer.name}
          placeholder={t.layers.types[layer.type]}
          onChange={(e) => ops.updateLayer(layer.id, (l) => void (l.name = e.target.value.slice(0, 80)), 'name')}
        />
        <Tooltip label={layer.locked ? t.layers.unlock : t.layers.lock}>
          <Button
            size="iconSm"
            variant="ghost"
            aria-label={layer.locked ? t.layers.unlock : t.layers.lock}
            onClick={() => ops.updateLayer(layer.id, (l) => void (l.locked = !l.locked))}
          >
            {layer.locked ? <Lock /> : <LockOpen />}
          </Button>
        </Tooltip>
        <Tooltip label={t.layers.bringForward}>
          <Button size="iconSm" variant="ghost" aria-label={t.layers.bringForward} onClick={() => ops.reorderLayer(layer.id, 1)}>
            <ArrowUp />
          </Button>
        </Tooltip>
        <Tooltip label={t.layers.sendBackward}>
          <Button size="iconSm" variant="ghost" aria-label={t.layers.sendBackward} onClick={() => ops.reorderLayer(layer.id, -1)}>
            <ArrowDown />
          </Button>
        </Tooltip>
        <Tooltip label={t.common.duplicate} shortcut="⌘D">
          <Button size="iconSm" variant="ghost" aria-label={t.common.duplicate} onClick={() => ops.duplicateLayers([layer.id])}>
            <Copy />
          </Button>
        </Tooltip>
        <Tooltip label={t.common.delete} shortcut="⌫">
          <Button size="iconSm" variant="ghost" aria-label={t.common.delete} onClick={() => ops.deleteLayers([layer.id])}>
            <Trash2 />
          </Button>
        </Tooltip>
      </div>

      <LayerProps layer={layer} P={P} />

      <Section title={t.layers.position}>
        <div className="grid grid-cols-2 gap-2">
          <Row label="X">
            <NumberField
              label="X"
              value={Math.round(cur.x * 1000) / 10}
              step={0.5}
              unit="%"
              onChange={(v) => v != null && ops.setLayerTransform(layer.id, now(), { x: v / 100 })}
            />
          </Row>
          <Row label="Y">
            <NumberField
              label="Y"
              value={Math.round(cur.y * 1000) / 10}
              step={0.5}
              unit="%"
              onChange={(v) => v != null && ops.setLayerTransform(layer.id, now(), { y: v / 100 })}
            />
          </Row>
          <Row label={t.layers.scale}>
            <NumberField
              label={t.layers.scale}
              value={Math.round(cur.scale * 100)}
              min={5}
              max={2000}
              unit="%"
              onChange={(v) => v != null && ops.setLayerTransform(layer.id, now(), { scale: v / 100 })}
            />
          </Row>
          <Row label={t.layers.rotation}>
            <NumberField
              label={t.layers.rotation}
              value={Math.round(cur.rotation)}
              min={-3600}
              max={3600}
              unit="°"
              onChange={(v) => v != null && ops.setLayerTransform(layer.id, now(), { rotation: v })}
            />
          </Row>
        </div>
        <Row label={t.layers.opacity} value={`${Math.round(cur.opacity * 100)} %`}>
          <Slider label={t.layers.opacity} value={cur.opacity} onChange={(v) => ops.setLayerTransform(layer.id, now(), { opacity: v }, 'opacity')} />
        </Row>
        <div className="flex items-center gap-1">
          {(
            [
              ['left', AlignStartVertical, t.layers.alignLeft],
              ['center', AlignCenterVertical, t.layers.alignCenter],
              ['right', AlignEndVertical, t.layers.alignRight],
              ['top', AlignStartHorizontal, t.layers.alignTop],
              ['middle', AlignCenterHorizontal, t.layers.alignMiddle],
              ['bottom', AlignEndHorizontal, t.layers.alignBottom],
            ] as const
          ).map(([how, Icon, label]) => (
            <Tooltip key={how} label={label}>
              <Button size="iconSm" variant="ghost" aria-label={label} onClick={() => alignOne(layer, how, now())}>
                <Icon />
              </Button>
            </Tooltip>
          ))}
        </div>
      </Section>

      <Section
        title={t.layers.keyframes}
        action={
          <Button size="sm" variant="link" disabled={onKey} onClick={() => ops.addKeyframe(layer.id, now())}>
            <Diamond className="size-3.5" />
            {t.layers.addKeyframe}
          </Button>
        }
      >
        {layer.keyframes.length < 2 ? <p className="text-[12px] text-fg-muted">{t.layers.keyframeHint}</p> : null}
        <ul className="flex flex-col gap-1.5">
          {sorted.map((k, i) => (
            <li key={`${k.t}-${i}`} className={cn('flex items-center gap-2 rounded-sm px-1.5 py-1 text-[12px]', k === sorted[onIdx] && 'bg-red-500/10')}>
              <button
                type="button"
                className="tabular w-14 text-left font-medium hover:text-accent-fg"
                onClick={() => useEditor.getState().setTime(layer.start + k.t)}
              >
                {k.t.toFixed(2)} s
              </button>
              <Select
                label={t.layers.easing}
                size="sm"
                value={k.easing}
                onChange={(v) =>
                  ops.updateLayer(layer.id, (l) => {
                    const kk = l.keyframes.find((x) => x.t === k.t);
                    if (kk) kk.easing = v;
                  })
                }
                options={EASINGS.map((e) => ({ value: e, label: t.layers.easings[e] }))}
              />
              {layer.keyframes.length > 1 ? (
                <Button
                  size="iconSm"
                  variant="ghost"
                  aria-label={t.layers.removeKeyframe}
                  onClick={() => ops.removeKeyframe(layer.id, layer.keyframes.indexOf(k))}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t.layers.timing}>
        <div className="grid grid-cols-2 gap-2">
          <Row label={t.layers.start}>
            <NumberField
              label={t.layers.start}
              value={Math.round(layer.start * 100) / 100}
              min={0}
              max={total}
              step={0.1}
              unit="s"
              onChange={(v) => v != null && ops.setLayerTiming(layer.id, v, layer.end)}
            />
          </Row>
          <Row label={t.layers.end}>
            <NumberField
              label={t.layers.end}
              value={Math.round(layer.end * 100) / 100}
              min={0}
              max={total}
              step={0.1}
              unit="s"
              onChange={(v) => v != null && ops.setLayerTiming(layer.id, layer.start, v)}
            />
          </Row>
          <Row label={t.layers.animIn}>
            <Select
              label={t.layers.animIn}
              size="sm"
              value={layer.animIn.preset}
              onChange={(v) => ops.updateLayer(layer.id, (l) => void (l.animIn.preset = v))}
              options={ANIMS.map((a) => ({ value: a, label: t.layers.anims[a] }))}
            />
          </Row>
          <Row label={t.layers.animOut}>
            <Select
              label={t.layers.animOut}
              size="sm"
              value={layer.animOut.preset}
              onChange={(v) => ops.updateLayer(layer.id, (l) => void (l.animOut.preset = v))}
              options={ANIMS.map((a) => ({ value: a, label: t.layers.anims[a] }))}
            />
          </Row>
        </div>
      </Section>
    </div>
  );
});

/** "index of the keyframe in effect:index of the keyframe under the playhead (-1: none)" in time
 *  order – a primitive, so the inspector re-renders only when it changes, not on every tick. */
export function layerKeyState(layer: Layer, time: number): string {
  const lt = time - layer.start;
  const sorted = [...layer.keyframes].sort((a, b) => a.t - b.t);
  let idx = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].t <= lt + 1e-6) idx = i;
  const on = layer.keyframes.length > 1 ? sorted.findIndex((k) => Math.abs(k.t - lt) < 1 / 60) : -1;
  return `${idx}:${on}`;
}

function alignOne(layer: Layer, how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom', time: number) {
  const s = useEditor.getState();
  const m = primaryMedia(s.doc);
  const W = 1000;
  const H = m ? (W * m.height) / Math.max(1, m.width) : 562;
  const env = layerEnv({ project: s.doc, width: W, height: H, locale: 'en', images: new Map() }, time);
  const b = measureLayer(layer, env);
  ops.alignLayers([layer.id], how, { [layer.id]: { w: b.w / W, h: b.h / H } }, time);
}

function MultiLayerInspector({ ids }: { ids: string[] }) {
  const { t } = useI18n();
  const time = () => useEditor.getState().time;
  return (
    <div>
      <Section title={`${ids.length} ${t.layers.title.toLowerCase()}`}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => ops.alignLayers(ids, 'center', {}, time())}>
            <AlignCenterVertical />
            {t.layers.alignCenter}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => ops.alignLayers(ids, 'middle', {}, time())}>
            <AlignCenterHorizontal />
            {t.layers.alignMiddle}
          </Button>
          <Button size="sm" variant="secondary" disabled={ids.length < 3} onClick={() => ops.distributeLayers(ids, 'x', time())}>
            {t.layers.distributeH}
          </Button>
          <Button size="sm" variant="secondary" disabled={ids.length < 3} onClick={() => ops.distributeLayers(ids, 'y', time())}>
            {t.layers.distributeV}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => ops.duplicateLayers(ids)}>
            <Copy />
            {t.common.duplicate}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => ops.deleteLayers(ids)}>
            <Trash2 />
            {t.common.delete}
          </Button>
        </div>
      </Section>
    </div>
  );
}

const FONT_IDS = Object.keys(FONTS) as FontId[];

function LayerProps({ layer, P }: { layer: Layer; P: (p: Record<string, unknown>) => void }) {
  const { t, f } = useI18n();
  const shots = useEditor((s) => s.doc.shots);
  const shotOptions = [
    { value: '__current', label: t.layers.currentShot },
    ...shots.filter((s) => s.kind !== 'putt').map((s, i) => ({ value: s.id, label: s.label || f(t.shots.shot, { n: i + 1 }) })),
  ];
  switch (layer.type) {
    case 'text': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.text}>
          <Textarea
            id={`layer-text-${layer.id}`}
            aria-label={t.layers.text}
            className="min-h-16 text-[13px]"
            value={p.text}
            maxLength={500}
            onChange={(e) => P({ text: e.target.value })}
          />
          <FontRow font={p.font} weight={p.weight} onChange={P} />
          <Row label={t.layers.size} value={`${Math.round(p.size * 1000) / 10} %`}>
            <Slider label={t.layers.size} value={p.size} min={0.01} max={0.25} step={0.001} onChange={(v) => P({ size: v })} />
          </Row>
          <Row label={t.layers.color}>
            <ColorField label={t.layers.color} value={p.color} onChange={(c) => P({ color: c })} />
          </Row>
          <Row label={t.layers.align}>
            <Segmented
              label={t.layers.align}
              size="sm"
              value={p.align}
              onChange={(v) => P({ align: v })}
              options={[
                { value: 'left', label: t.layers.alignLeft },
                { value: 'center', label: t.layers.alignCenter },
                { value: 'right', label: t.layers.alignRight },
              ]}
            />
          </Row>
          <Toggle label={t.layers.background} checked={!!p.background} onChange={(v) => P({ background: v ? '#111113' : null })} />
          {p.background ? <ColorField label={t.layers.background} value={p.background} onChange={(c) => P({ background: c })} /> : null}
          <Toggle label={t.layers.uppercase} checked={p.uppercase} onChange={(v) => P({ uppercase: v })} />
          <Toggle label={t.layers.shadow} checked={p.shadow} onChange={(v) => P({ shadow: v })} />
          <Row label={t.layers.letterSpacing} value={p.letterSpacing.toFixed(2)}>
            <Slider label={t.layers.letterSpacing} value={p.letterSpacing} min={-0.1} max={0.5} step={0.01} onChange={(v) => P({ letterSpacing: v })} />
          </Row>
        </Section>
      );
    }
    case 'statCard': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.statCard}>
          <Row label={t.layers.shot}>
            <Select
              label={t.layers.shot}
              size="sm"
              value={p.shotId ?? '__current'}
              onChange={(v) => P({ shotId: v === '__current' ? null : v })}
              options={shotOptions}
            />
          </Row>
          <Row label={t.layers.fields}>
            <div className="flex flex-wrap gap-1.5">
              {(['carry', 'apex', 'ballSpeed', 'launch', 'flightTime', 'curve'] as StatField[]).map((k) => {
                const on = p.fields.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const next = on ? p.fields.filter((x) => x !== k) : [...p.fields, k];
                      if (next.length) P({ fields: next });
                    }}
                    className="rounded-full border border-border-strong px-2.5 py-1 text-[12px] aria-pressed:border-red-500 aria-pressed:bg-red-500/10"
                  >
                    {t.tracer.stats[k]}
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label={t.layers.themeLabel}>
            <Segmented
              label={t.layers.themeLabel}
              size="sm"
              value={p.theme}
              onChange={(v) => P({ theme: v })}
              options={(['dark', 'light', 'accent'] as const).map((v) => ({ value: v, label: t.layers.themes[v] }))}
            />
          </Row>
          <Row label={t.layers.titleLabel}>
            <Input className="h-8 text-[13px]" aria-label={t.layers.titleLabel} value={p.title} maxLength={60} onChange={(e) => P({ title: e.target.value })} />
          </Row>
          <Row label={t.layers.accent}>
            <ColorField label={t.layers.accent} value={p.accent} onChange={(c) => P({ accent: c })} />
          </Row>
          <Row label={t.layers.size} value={`${Math.round(p.width * 100)} %`}>
            <Slider label={t.layers.size} value={p.width} min={0.12} max={0.9} step={0.01} onChange={(v) => P({ width: v })} />
          </Row>
        </Section>
      );
    }
    case 'shape': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.shape}>
          <Segmented
            label={t.layers.shapeKind}
            size="sm"
            value={p.shape}
            onChange={(v) => P({ shape: v })}
            options={(['rect', 'ellipse', 'line'] as const).map((v) => ({ value: v, label: t.layers.shapes[v] }))}
          />
          <div className="grid grid-cols-2 gap-2">
            <Row label="B">
              <NumberField label="B" value={Math.round(p.w * 1000) / 10} unit="%" step={0.5} onChange={(v) => v != null && P({ w: v / 100 })} />
            </Row>
            <Row label="H">
              <NumberField label="H" value={Math.round(p.h * 1000) / 10} unit="%" step={0.5} onChange={(v) => v != null && P({ h: v / 100 })} />
            </Row>
          </div>
          <Toggle label={t.layers.fill} checked={!!p.fill} onChange={(v) => P({ fill: v ? '#ffffff' : null })} />
          {p.fill ? <ColorField label={t.layers.fill} value={p.fill} onChange={(c) => P({ fill: c })} /> : null}
          <Toggle label={t.layers.stroke} checked={!!p.stroke} onChange={(v) => P({ stroke: v ? '#ff3b30' : null })} />
          {p.stroke ? <ColorField label={t.layers.stroke} value={p.stroke} onChange={(c) => P({ stroke: c })} /> : null}
          {p.shape === 'rect' ? (
            <Row label={t.layers.radius}>
              <Slider label={t.layers.radius} value={p.radius} min={0} max={0.1} step={0.002} onChange={(v) => P({ radius: v })} />
            </Row>
          ) : null}
        </Section>
      );
    }
    case 'arrow': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.arrow}>
          <Row label={t.layers.color}>
            <ColorField label={t.layers.color} value={p.color} onChange={(c) => P({ color: c })} />
          </Row>
          <Row label={t.layers.bend}>
            <Slider label={t.layers.bend} value={p.bend} min={-1} max={1} step={0.05} onChange={(v) => P({ bend: v })} />
          </Row>
          <Row label="Δ X / Δ Y">
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="dx" value={Math.round(p.dx * 100)} unit="%" onChange={(v) => v != null && P({ dx: v / 100 })} />
              <NumberField label="dy" value={Math.round(p.dy * 100)} unit="%" onChange={(v) => v != null && P({ dy: v / 100 })} />
            </div>
          </Row>
          <Row label={t.tracer.width}>
            <Slider label={t.tracer.width} value={p.width} min={0.002} max={0.03} step={0.001} onChange={(v) => P({ width: v })} />
          </Row>
          <Toggle label={t.layers.head} checked={p.head} onChange={(v) => P({ head: v })} />
          <Toggle label={t.layers.dashed} checked={p.dashed} onChange={(v) => P({ dashed: v })} />
        </Section>
      );
    }
    case 'image': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.image}>
          <Row label={t.layers.size} value={`${Math.round(p.w * 100)} %`}>
            <Slider label={t.layers.size} value={p.w} min={0.03} max={1} step={0.005} onChange={(v) => P({ w: v })} />
          </Row>
          <Row label={t.layers.radius}>
            <Slider label={t.layers.radius} value={p.radius} min={0} max={0.5} step={0.01} onChange={(v) => P({ radius: v })} />
          </Row>
        </Section>
      );
    }
    case 'lowerThird': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.lowerThird}>
          <Row label={t.layers.titleLabel}>
            <Input
              id={`layer-text-${layer.id}`}
              className="h-8 text-[13px]"
              aria-label={t.layers.titleLabel}
              value={p.title}
              maxLength={80}
              onChange={(e) => P({ title: e.target.value })}
            />
          </Row>
          <Row label={t.layers.subtitle}>
            <Input
              className="h-8 text-[13px]"
              aria-label={t.layers.subtitle}
              value={p.subtitle}
              maxLength={120}
              onChange={(e) => P({ subtitle: e.target.value })}
            />
          </Row>
          <Row label={t.layers.styleLabel}>
            <Segmented
              label={t.layers.styleLabel}
              size="sm"
              value={p.style}
              onChange={(v) => P({ style: v })}
              options={(['bar', 'minimal', 'tv'] as const).map((v) => ({ value: v, label: t.layers.lowerThirdStyles[v] }))}
            />
          </Row>
          <FontRow font={p.font} onChange={P} />
          <Row label={t.layers.accent}>
            <ColorField label={t.layers.accent} value={p.accent} onChange={(c) => P({ accent: c })} />
          </Row>
        </Section>
      );
    }
    case 'holeInfo': {
      const p = layer.props as LayerOf<'holeInfo'>['props'];
      return (
        <Section title={t.layers.types.holeInfo}>
          <div className="grid grid-cols-3 gap-2">
            <Row label={t.layers.hole}>
              <NumberField label={t.layers.hole} value={p.hole} min={1} max={99} onChange={(v) => v != null && P({ hole: Math.round(v) })} />
            </Row>
            <Row label={t.layers.par}>
              <NumberField label={t.layers.par} value={p.par} min={2} max={7} onChange={(v) => v != null && P({ par: Math.round(v) })} />
            </Row>
            <Row label={t.layers.length}>
              <NumberField label={t.layers.length} value={p.length} min={0} max={1000} unit={p.unit} onChange={(v) => v != null && P({ length: v })} />
            </Row>
          </div>
          <Row label={t.layers.club}>
            <Input className="h-8 text-[13px]" aria-label={t.layers.club} value={p.club} maxLength={40} onChange={(e) => P({ club: e.target.value })} />
          </Row>
          <Row label={t.common.units}>
            <Segmented
              label={t.common.units}
              size="sm"
              value={p.unit}
              onChange={(v) => P({ unit: v })}
              options={[
                { value: 'm', label: t.common.metres },
                { value: 'yd', label: t.common.yards },
              ]}
            />
          </Row>
          <Row label={t.layers.accent}>
            <ColorField label={t.layers.accent} value={p.accent} onChange={(c) => P({ accent: c })} />
          </Row>
        </Section>
      );
    }
    case 'distance': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.distance}>
          <Row label={t.layers.shot}>
            <Select
              label={t.layers.shot}
              size="sm"
              value={p.shotId ?? '__current'}
              onChange={(v) => P({ shotId: v === '__current' ? null : v })}
              options={shotOptions}
            />
          </Row>
          <Row label={t.layers.value}>
            <NumberField
              label={t.layers.value}
              value={p.value}
              nullable
              min={0}
              max={1000}
              unit={p.unit}
              placeholder={t.layers.valueAuto}
              onChange={(v) => P({ value: v })}
            />
          </Row>
          <Row label={t.layers.label}>
            <Input className="h-8 text-[13px]" aria-label={t.layers.label} value={p.label} maxLength={40} onChange={(e) => P({ label: e.target.value })} />
          </Row>
          <Row label={t.common.units}>
            <Segmented
              label={t.common.units}
              size="sm"
              value={p.unit}
              onChange={(v) => P({ unit: v })}
              options={[
                { value: 'm', label: t.common.metres },
                { value: 'yd', label: t.common.yards },
              ]}
            />
          </Row>
          <Row label={t.layers.accent}>
            <ColorField label={t.layers.accent} value={p.accent} onChange={(c) => P({ accent: c })} />
          </Row>
        </Section>
      );
    }
    case 'courseMap': {
      const p = layer.props;
      return (
        <Section title={t.layers.types.courseMap}>
          <Row label={t.layers.titleLabel}>
            <Input className="h-8 text-[13px]" aria-label={t.layers.titleLabel} value={p.title} maxLength={60} onChange={(e) => P({ title: e.target.value })} />
          </Row>
          <Row label={t.layers.size} value={`${Math.round(p.size * 100)} %`}>
            <Slider label={t.layers.size} value={p.size} min={0.15} max={0.9} step={0.01} onChange={(v) => P({ size: v })} />
          </Row>
          <Row label={t.layers.themeLabel}>
            <Segmented
              label={t.layers.themeLabel}
              size="sm"
              value={p.theme}
              onChange={(v) => P({ theme: v })}
              options={(['dark', 'light'] as const).map((v) => ({ value: v, label: t.layers.themes[v] }))}
            />
          </Row>
          <Toggle label={t.map.carry} checked={p.showDistance} onChange={(v) => P({ showDistance: v })} />
          <Row label={t.common.units}>
            <Segmented
              label={t.common.units}
              size="sm"
              value={p.unit}
              onChange={(v) => P({ unit: v })}
              options={[
                { value: 'm', label: t.common.metres },
                { value: 'yd', label: t.common.yards },
              ]}
            />
          </Row>
          <Row label={t.layers.accent}>
            <ColorField label={t.layers.accent} value={p.accent} onChange={(c) => P({ accent: c })} />
          </Row>
          <p className="text-[12px] text-fg-muted">{p.attribution}</p>
        </Section>
      );
    }
  }
}

function FontRow({ font, weight, onChange }: { font: FontId; weight?: number; onChange: (p: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[1fr_88px] gap-2">
      <Row label={t.layers.font}>
        <Select
          label={t.layers.font}
          size="sm"
          value={font}
          onChange={(v) => onChange({ font: v })}
          options={FONT_IDS.map((id) => ({ value: id, label: <span style={{ fontFamily: `"${FONTS[id].family}"` }}>{FONTS[id].label}</span> }))}
        />
      </Row>
      {weight != null ? (
        <Row label={t.layers.weight}>
          <Select
            label={t.layers.weight}
            size="sm"
            value={String(weight)}
            onChange={(v) => onChange({ weight: Number(v) })}
            options={FONTS[font].weights.map((w) => ({ value: String(w), label: String(w) }))}
          />
        </Row>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Clips, music, project

const ClipInspector = memo(function ClipInspector({ id }: { id: string }) {
  const { t } = useI18n();
  const clip = useEditor((s) => s.doc.clips.find((c) => c.id === id));
  const count = useEditor((s) => s.doc.clips.length);
  if (!clip) return null;
  return (
    <div>
      <Section title={clip.kind === 'freeze' ? t.timeline.freeze : t.timeline.video}>
        {clip.kind === 'video' ? (
          <>
            <Row label={t.timeline.speed} value={`${clip.speed}×`}>
              <Segmented
                label={t.timeline.speed}
                size="sm"
                value={String(clip.speed)}
                onChange={(v) => ops.setClipProps(id, { speed: Number(v) })}
                options={['0.25', '0.5', '1', '1.5', '2'].map((v) => ({ value: v, label: `${v}×` }))}
              />
            </Row>
            <Row label={t.timeline.clipVolume} value={`${Math.round(clip.volume * 100)} %`}>
              <Slider
                label={t.timeline.clipVolume}
                value={clip.volume}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => ops.setClipProps(id, { volume: v }, 'vol')}
              />
            </Row>
            <Toggle label={t.timeline.mute} checked={clip.muted} onChange={(v) => ops.setClipProps(id, { muted: v })} />
          </>
        ) : (
          <Row label={t.tracer.flightTime}>
            <NumberField
              label={t.timeline.freeze}
              value={clip.duration}
              min={0.1}
              max={60}
              step={0.1}
              unit="s"
              onChange={(v) => v != null && ops.setFreezeDuration(id, v)}
            />
          </Row>
        )}
        <Button size="sm" variant="ghost" disabled={count < 2} onClick={() => ops.deleteClip(id)}>
          <Trash2 />
          {t.timeline.delete}
        </Button>
      </Section>
    </div>
  );
});

const AudioInspector = memo(function AudioInspector({ id }: { id: string }) {
  const { t } = useI18n();
  const a = useEditor((s) => s.doc.audioTracks.find((x) => x.id === id));
  if (!a) return null;
  return (
    <Section title={t.audio.music}>
      <Row label={t.audio.volume} value={`${Math.round(a.volume * 100)} %`}>
        <Slider label={t.audio.volume} value={a.volume} min={0} max={1.5} step={0.05} onChange={(v) => ops.updateMusic(id, { volume: v }, 'vol')} />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label={t.audio.fadeIn}>
          <NumberField
            label={t.audio.fadeIn}
            value={a.fadeIn}
            min={0}
            max={30}
            step={0.1}
            unit="s"
            onChange={(v) => v != null && ops.updateMusic(id, { fadeIn: v })}
          />
        </Row>
        <Row label={t.audio.fadeOut}>
          <NumberField
            label={t.audio.fadeOut}
            value={a.fadeOut}
            min={0}
            max={30}
            step={0.1}
            unit="s"
            onChange={(v) => v != null && ops.updateMusic(id, { fadeOut: v })}
          />
        </Row>
      </div>
      <Row label={t.audio.start}>
        <NumberField label={t.audio.start} value={a.start} min={0} step={0.1} unit="s" onChange={(v) => v != null && ops.updateMusic(id, { start: v })} />
      </Row>
      <Button size="sm" variant="ghost" onClick={() => ops.removeMusic(id)}>
        <Trash2 />
        {t.common.remove}
      </Button>
    </Section>
  );
});

/** The playhead in seconds, rounded – its own component so ticks re-render only this text. */
function PlayheadSeconds() {
  const s = useEditor((st) => Math.round(st.time * 10) / 10);
  return <>{s.toFixed(1)}</>;
}

const ProjectInspector = memo(function ProjectInspector() {
  const { t, locale } = useI18n();
  const format = useEditor((s) => s.doc.format);
  const audio = useEditor((s) => s.doc.audio);
  const units = useEditor((s) => s.doc.units);
  const hasClip = useEditor((s) => !!clipAt(s.doc.clips, s.time));
  const tool = useEditor((s) => s.tool);
  return (
    <div data-testid="project-inspector">
      <Section title={t.format.title}>
        <Row label={t.format.aspect}>
          <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label={t.format.aspect}>
            {(['original', '16:9', '9:16', '1:1', '4:5'] as const).map((a) => {
              const r = a === 'original' ? 1.4 : a === '16:9' ? 16 / 9 : a === '9:16' ? 9 / 16 : a === '1:1' ? 1 : 0.8;
              return (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={format.aspect === a}
                  title={t.format.aspects[a]}
                  onClick={() => ops.setAspect(a, locale)}
                  className="flex flex-col items-center gap-1 rounded-md border border-border py-2 text-[11px] hover:border-border-strong aria-checked:border-red-500 aria-checked:bg-red-500/10"
                >
                  <span className="rounded-[2px] border-2 border-current" style={{ width: r >= 1 ? 22 : 22 * r, height: r >= 1 ? 22 / r : 22 }} aria-hidden />
                  {a === 'original' ? t.format.aspects.original : a}
                </button>
              );
            })}
          </div>
        </Row>
        {format.aspect !== 'original' ? (
          <Row label={t.format.fill}>
            <Segmented
              label={t.format.fill}
              size="sm"
              value={format.fill}
              onChange={(v) => ops.setFill(v)}
              options={[
                { value: 'crop', label: t.format.fillCrop },
                { value: 'blur', label: t.format.fillBlur },
              ]}
            />
          </Row>
        ) : null}
        {format.aspect !== 'original' && format.fill === 'crop' ? (
          <>
            <Row label={t.format.reframe}>
              <Segmented
                label={t.format.reframe}
                size="sm"
                value={format.reframe.mode}
                onChange={(v) => (v === 'auto' ? ops.autoReframe() : ops.setReframeMode(v))}
                options={(['center', 'auto', 'manual'] as const).map((v) => ({ value: v, label: t.format.reframeModes[v] }))}
              />
            </Row>
            <p className="text-[12px] text-fg-muted">{format.reframe.mode === 'auto' ? t.format.autoReframeHint : t.format.dragToReframe}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={tool === 'reframe' ? 'primary' : 'secondary'}
                disabled={!hasClip}
                onClick={() => useEditor.getState().setTool(tool === 'reframe' ? 'select' : 'reframe')}
              >
                {t.format.addReframeKey}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => ops.autoReframe()}>
                <Wand2 />
                {t.format.autoReframe}
              </Button>
              {format.reframe.keyframes.length ? (
                <Button size="sm" variant="ghost" onClick={() => ops.clearReframe()}>
                  {t.format.clearReframe}
                </Button>
              ) : null}
            </div>
            {format.reframe.keyframes.length ? (
              <p className="tabular text-[12px] text-fg-subtle">
                {format.reframe.keyframes.length} keyframes · <PlayheadSeconds /> s
              </p>
            ) : null}
          </>
        ) : null}
      </Section>
      <Section title={t.audio.original}>
        <Row label={t.audio.volume} value={`${Math.round(audio.originalVolume * 100)} %`}>
          <Slider
            label={t.audio.volume}
            value={audio.originalVolume}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => ops.setOriginalAudio({ originalVolume: v }, 'orig-vol')}
          />
        </Row>
        <Toggle label={t.audio.mute} checked={audio.muted} onChange={(v) => ops.setOriginalAudio({ muted: v })} />
      </Section>
      <Section title={t.common.units}>
        <Segmented
          label={t.common.units}
          value={units}
          onChange={(v) => ops.setUnits(v)}
          options={[
            { value: 'm', label: t.common.metres },
            { value: 'yd', label: t.common.yards },
          ]}
        />
      </Section>
    </div>
  );
});
