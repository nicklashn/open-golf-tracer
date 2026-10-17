'use client';

/**
 * The scorecard: one row per hole in playing order (par, strokes, putts, score to par, out/in/
 * total), from the strokes found on the clips (@golf/compose holeScores). What is not sure is
 * marked; a click on a hole shows its first shot and opens the hole for corrections, which are
 * stored in the project (`scoreEdits`) and used wherever the score is.
 */
import { scoreName, summarize, toPar, type HoleScore, type ScoreGap } from '@golf/compose';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/ui/controls';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import * as ops from './ops';
import { useEditor } from './store';

/** Hole · Par · Strokes · Putts · ± — and room for the chevron. */
const GRID = 'grid grid-cols-[2.25rem_2rem_minmax(0,1fr)_2.5rem_2.5rem_1rem] items-center gap-x-1';

export function ScorePanel() {
  const { t, f } = useI18n();
  const T = t.score;
  // Only what the score depends on: a tracer drag elsewhere does not recount the round.
  const shots = useEditor((s) => s.doc.shots);
  const media = useEditor((s) => s.doc.media);
  const clips = useEditor((s) => s.doc.clips);
  const edits = useEditor((s) => s.doc.scoreEdits);
  const name = useEditor((s) => s.doc.name);
  const summary = useMemo(() => summarize({ ...useEditor.getState().doc, shots, media, clips, scoreEdits: edits, name }), [shots, media, clips, edits, name]);
  const [open, setOpen] = useState<string | null>(null);
  const holes = summary.holes;
  const videos = summary.clips;
  const noHole = videos.filter((c) => !c.hole);

  if (!holes.length) {
    const lead = videos.every((c) => !c.gps) ? T.noGps : summary.course ? f(T.offCourse, { course: summary.course }) : T.range;
    return (
      <div className="flex flex-col gap-3 p-3" data-testid="score-panel">
        <div className="flex flex-col items-center rounded-md border border-dashed border-border-strong px-4 py-6 text-center" data-testid="score-empty">
          <Birdie mood="confused" size={56} />
          <p className="mt-2 text-[13px] font-medium">{T.emptyTitle}</p>
          <p className="mt-1 text-[12px] leading-snug text-fg-muted">{lead}</p>
        </div>
        {noHole.length ? <ClipHoles clips={noHole} open={lead !== T.range} title={T.clipsTitle} /> : null}
      </div>
    );
  }

  const scored = holes.filter((h) => h.strokes !== null && h.par !== null);
  const numeric = holes.every((h) => /^\d+$/.test(h.hole));
  const front = numeric ? holes.filter((h) => Number(h.hole) <= 9) : [];
  const back = numeric ? holes.filter((h) => Number(h.hole) > 9) : [];
  const sum = sumOf(scored);

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="score-panel">
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold">{summary.course || T.title}</h2>
          <p className="text-[12px] text-fg-muted" data-testid="score-status">
            {!scored.length
              ? T.noneScored
              : scored.length === holes.length
                ? f(T.allScored, { n: holes.length })
                : f(T.holesScored, { n: scored.length, total: holes.length })}
          </p>
        </div>
        {scored.length ? (
          <p className="tabular shrink-0 text-right leading-none" data-testid="score-total">
            <span className="text-[22px] font-semibold">{sum.strokes}</span>
            <span className={cn('ml-1.5 text-[13px] font-medium', toneOf(sum.strokes - sum.par))}>{toPar(sum.strokes - sum.par)}</span>
          </p>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-md border border-border" role="group" aria-label={T.title}>
        <div className={cn(GRID, 'bg-surface-sunken px-2 py-1.5 text-[11px] font-medium text-fg-muted')} aria-hidden>
          <span>{T.hole}</span>
          <span className="text-center">{T.par}</span>
          <span className="text-center">{T.strokes}</span>
          <span className="text-center">{T.putts}</span>
          <span className="text-center">{T.toPar}</span>
          <span />
        </div>
        <ul className="divide-y divide-border">
          {holes.map((h) => (
            <HoleRow key={h.hole} h={h} open={open === h.hole} onToggle={() => setOpen(open === h.hole ? null : h.hole)} />
          ))}
        </ul>
        <div className="border-t border-border-strong bg-surface-sunken text-[12px]">
          {front.length && back.length ? (
            <>
              <SumRow label={T.out} holes={front} />
              <SumRow label={T.in} holes={back} />
            </>
          ) : null}
          <SumRow label={T.total} holes={holes} strong />
        </div>
      </div>
      <p className="text-[11px] leading-snug text-fg-subtle">
        {scored.length && scored.length < holes.length ? `* ${f(T.partial, { n: scored.length })} ` : ''}
        {T.legend}
      </p>
      {noHole.length ? <ClipHoles clips={noHole} title={f(T.clipsMissing, { n: noHole.length })} /> : null}
    </div>
  );
}

function sumOf(holes: HoleScore[]) {
  const done = holes.filter((h) => h.strokes !== null && h.par !== null);
  return {
    n: done.length,
    par: done.reduce((n, h) => n + h.par!, 0),
    strokes: done.reduce((n, h) => n + h.strokes!, 0),
    putts: done.reduce((n, h) => n + h.putts, 0),
  };
}

const toneOf = (d: number) => (d < 0 ? 'text-red-400' : d > 0 ? 'text-sky-300' : 'text-fg-muted');

function SumRow({ label, holes, strong }: { label: string; holes: HoleScore[]; strong?: boolean }) {
  const s = sumOf(holes);
  const partial = s.n < holes.length;
  return (
    <div className={cn(GRID, 'tabular px-2 py-1.5', strong && 'font-semibold')} data-testid={`score-sum-${label}`}>
      <span className="text-fg-muted">{label}</span>
      <span className="text-center text-fg-muted">
        {s.n ? s.par : '–'}
        {s.n && partial ? <sup className="ml-px text-[9px] text-fg-subtle">*</sup> : null}
      </span>
      <span className="text-center">
        {s.n ? s.strokes : '–'}
        {s.n && partial ? <sup className="ml-px text-[9px] font-normal text-fg-subtle">*</sup> : null}
      </span>
      <span className="text-center text-fg-muted">{s.n ? s.putts : '–'}</span>
      <span className={cn('text-center', s.n ? toneOf(s.strokes - s.par) : 'text-fg-subtle')}>{s.n ? toPar(s.strokes - s.par) : '–'}</span>
      <span />
    </div>
  );
}

/** Strokes as on a paper card: circles under par, squares over (two for eagle / double bogey or worse). */
function StrokeMark({ n, par, unsure }: { n: number; par: number | null; unsure: boolean }) {
  const d = par === null || unsure ? 0 : n - par;
  const shape = d < 0 ? 'rounded-full' : d > 0 ? 'rounded-[3px]' : '';
  const ring = d < 0 ? 'border-red-400 text-red-300' : d > 0 ? 'border-sky-300/80 text-sky-200' : 'border-transparent';
  const inner = (
    <span className={cn('inline-flex size-[22px] items-center justify-center border text-[13px] font-semibold', shape, ring, unsure && 'text-warning')}>
      {n}
      {unsure ? <span className="text-[10px]">?</span> : null}
    </span>
  );
  return Math.abs(d) >= 2 ? <span className={cn('inline-flex border p-px', shape, ring)}>{inner}</span> : inner;
}

function HoleRow({ h, open, onToggle }: { h: HoleScore; open: boolean; onToggle: () => void }) {
  const { t, f, locale } = useI18n();
  const T = t.score;
  const unsure = h.strokes === null;
  const puttsUnsure = h.puttsUnsure || h.why.includes('not_holed');
  const strokes = h.strokes ?? h.counted;
  const diff = h.strokes !== null && h.par !== null ? h.strokes - h.par : null;
  const label = f(T.row, {
    hole: h.hole,
    par: h.par ?? '?',
    strokes: `${strokes}${unsure ? ` (${T.unsure})` : ''}`,
    putts: `${h.putts}${puttsUnsure ? ` (${T.unsure})` : ''}`,
  });
  const name = diff !== null ? scoreName(h.strokes!, h.par!, locale) : '';

  function show() {
    const doc = useEditor.getState().doc;
    const first = h.shotIds.map((id) => doc.shots.find((s) => s.id === id)).find((s) => s);
    if (first) ops.jumpToShot(first);
  }

  return (
    <li data-testid="score-hole" data-hole={h.hole}>
      <button
        type="button"
        className={cn(GRID, 'tabular w-full px-2 py-1 text-left text-[13px] transition-colors hover:bg-surface-sunken', open && 'bg-surface-sunken')}
        aria-expanded={open}
        aria-label={`${label}${name ? ` – ${name}` : ''}${h.edited.length ? ` (${T.edited})` : ''}`}
        onClick={() => {
          show();
          onToggle();
        }}
      >
        <span className="flex items-center gap-1 font-semibold">
          {h.hole}
          {h.edited.length ? <span className="size-1.5 rounded-full bg-fg-subtle" aria-hidden title={T.edited} /> : null}
        </span>
        <span className={cn('text-center text-fg-muted', h.par === null && 'text-warning')}>{h.par ?? '?'}</span>
        <span className="flex justify-center">
          <StrokeMark n={strokes} par={h.par} unsure={unsure} />
        </span>
        <span className={cn('text-center', puttsUnsure ? 'text-warning' : 'text-fg-muted')}>
          {h.putts}
          {puttsUnsure ? <span className="text-[10px]">?</span> : null}
        </span>
        <span className={cn('text-center text-[12px] font-medium', diff === null ? 'text-fg-subtle' : toneOf(diff))}>{diff === null ? '–' : toPar(diff)}</span>
        <ChevronDown className={cn('size-3.5 text-fg-subtle transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? <HoleEditor h={h} /> : null}
    </li>
  );
}

function HoleEditor({ h }: { h: HoleScore }) {
  const { t, f } = useI18n();
  const T = t.score;
  const edit = useEditor((s) => s.doc.scoreEdits?.[h.hole]);
  // What the clips say, without the user's numbers (shown as the placeholder and "found").
  const found = useFound(h.hole);
  const field = (key: 'par' | 'strokes' | 'putts', label: string, min: number, max: number) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-fg-muted">{label}</span>
      <NumberField
        label={`${T.hole} ${h.hole}: ${label}`}
        value={edit?.[key] ?? null}
        placeholder={found?.[key] != null ? String(found[key]) : '–'}
        nullable
        min={min}
        max={max}
        onChange={(v) => ops.setHoleEdit(h.hole, { [key]: v == null ? null : Math.round(v) })}
        className={cn('h-7', edit?.[key] !== undefined && 'border-fg-muted')}
      />
      {edit?.[key] !== undefined && found?.[key] != null ? <span className="tabular text-[10px] text-fg-subtle">{f(T.found, { n: found[key]! })}</span> : null}
    </label>
  );
  return (
    <div className="flex flex-col gap-2 border-t border-border bg-surface px-2.5 pt-2 pb-2.5" data-testid="score-editor">
      {h.why.length ? (
        <ul className="flex flex-col gap-0.5 text-[12px] text-warning">
          {h.why.map((w: ScoreGap) => (
            <li key={w}>{T.why[w]}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-[12px] leading-snug text-fg-muted">{T.editLead}</p>
      <div className="grid grid-cols-3 gap-2">
        {field('par', T.par, 2, 7)}
        {field('strokes', T.strokes, 1, 20)}
        {field('putts', T.putts, 0, 10)}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {h.edited.length ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => ops.setHoleEdit(h.hole, { par: null, strokes: null, putts: null })}
            data-testid="score-reset"
          >
            <RotateCcw />
            {T.reset}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The hole as the clips have it, before the user's corrections. */
function useFound(hole: string): { par: number | null; strokes: number | null; putts: number | null } | null {
  const shots = useEditor((s) => s.doc.shots);
  const media = useEditor((s) => s.doc.media);
  const clips = useEditor((s) => s.doc.clips);
  return useMemo(() => {
    const h = summarize({ ...useEditor.getState().doc, shots, media, clips, scoreEdits: undefined }).holes.find((x) => x.hole === hole);
    return h ? { par: h.par, strokes: h.counted, putts: h.putts } : null;
  }, [shots, media, clips, hole]);
}

/** Setting the hole of clips by hand: for clips without GPS, or filmed off the mapped holes. */
function ClipHoles({ clips, title, open }: { clips: { id: string; n: number; name: string }[]; title: string; open?: boolean }) {
  const { t, f } = useI18n();
  return (
    <details className="group rounded-md" open={open} data-testid="score-clips">
      <summary className="cursor-pointer select-none px-1 text-[12px] font-medium text-fg-muted hover:text-fg">{title}</summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {clips.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded-md px-1 py-0.5">
            <button type="button" className="min-w-0 flex-1 truncate text-left text-[12px] hover:underline" onClick={() => ops.jumpToMedia(c.id)}>
              <span className="tabular text-fg-subtle">{c.n}.</span> {c.name}
            </button>
            <NumberField
              label={f(t.score.clipHole, { name: c.name })}
              value={null}
              placeholder={t.score.hole}
              nullable
              min={1}
              max={27}
              onChange={(v) => v != null && ops.setClipHole(c.id, String(Math.round(v)))}
              className="h-7 w-16"
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
