'use client';

/**
 * "Make a video for me": pick clips, write a preference, and the server's compose job edits the
 * video. When the rules are unsure it asks once, with every question on one screen and the
 * default answer already picked; otherwise it runs to the end on its own. Questions about
 * particular shots show each one as a card (a short loop around the strike) that can be kept or
 * removed on its own, or opened in the editor.
 */
import {
  CHATGPT_USAGE_URL,
  clock,
  explainPreference,
  planFromRules,
  shotAnswerKey,
  summarize,
  videoTokenEstimate,
  type PlanItem,
  type PlanQuestion,
  type PreferenceChip,
  type ShotChoice,
} from '@golf/compose';
import { sourcePath, TEMPLATES } from '@golf/render';
import type { Project, Shot } from '@golf/schema';
import { Check, Clapperboard, Copy, ExternalLink, Loader2, MonitorPlay, Pause, Play, Smartphone, Sparkles, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Birdie } from '@/components/mascot/Birdie';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { ProgressBar } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { aiPrivacy, ChatGptPlanNote, ManageUsage, type AiSettingsInfo } from '@/components/app/AiSettings';
import { useJobEvents, type JobInfo } from '@/lib/events';
import { useI18n } from '@/lib/i18n/client';
import { jobMessage } from '@/lib/jobMessage';
import { cn } from '@/lib/cn';
import { saveNow } from './autosave';
import * as ops from './ops';
import { useEditor } from './store';

interface Result {
  projects?: { id: string; name: string }[];
  description?: string;
  notes?: string[];
  ai?: { provider: string; model: string } | null;
  usage?: { calls: number; inputTokens: number; outputTokens: number } | null;
}

export function AutoVideoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, locale } = useI18n();
  const T = t.auto;
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.projectId);
  const clips = useMemo(() => {
    const seen = new Set<string>();
    return doc.clips
      .filter((c) => !seen.has(c.mediaId) && seen.add(c.mediaId))
      .map((c) => doc.media[c.mediaId])
      .filter((m) => m && m.kind === 'video')
      .map((m) => ({ ...m, shots: doc.shots.filter((s) => s.mediaId === m.id && s.visible && s.kind === 'full').length }));
  }, [doc]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preference, setPreference] = useState('');
  const [kind, setKind] = useState<Kind>('youtube');
  const analysing = useEditor((s) => s.analysis.running);
  const shotCount = clips.reduce((n, c) => n + c.shots, 0);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<AiSettingsInfo | null>(null);

  useEffect(() => {
    if (open) void api<AiSettingsInfo>('/ai/settings').then(setAi, () => setAi(null));
  }, [open]);

  // A fresh dialog starts with every clip picked.
  useEffect(() => {
    if (open && !job) setPicked(new Set(clips.map((c) => c.id)));
  }, [open, job, clips]);

  useJobEvents(
    (ev) => {
      if (job && ev.job.id === job.id) setJob(ev.job);
    },
    open && job ? projectId : null,
  );

  const questions = (job?.status === 'awaiting_answers' ? (job.result.questions as PlanQuestion[] | undefined) : undefined) ?? [];
  useEffect(() => {
    if (questions.length) setAnswers((a) => Object.fromEntries(questions.map((q) => [q.id, a[q.id] ?? q.default])));
    // Only when a new set of questions arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.id]);

  async function start() {
    if (!picked.size) {
      setError(T.pickClips);
      return;
    }
    setError('');
    setBusy(true);
    try {
      await saveNow(true);
      const mediaIds = picked.size === clips.length ? [] : [...picked];
      // The format picked on a card leads; the free text adds to it ("only good shots" …).
      const wish = [T.kindPhrase[kind], preference.trim()].filter(Boolean).join('. ');
      setJob(await api<JobInfo>('/autovideo', { body: { projectId, preference: wish, locale, names: t.layers.types, mediaIds } }));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function answer(useDefaults: boolean) {
    if (!job) return;
    setBusy(true);
    try {
      // Send every answer, defaults included: putting is only shown on holes someone answered.
      const body = useDefaults ? Object.fromEntries(questions.map((q) => [q.id, q.default])) : answers;
      setJob(await api<JobInfo>(`/jobs/${job.id}/answers`, { body: { answers: body } }));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (job) await api(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {});
    setJob(null);
  }

  function reset() {
    setJob(null);
    setError('');
  }

  const working = !!job && (job.status === 'queued' || job.status === 'running');
  const result = (job?.status === 'succeeded' ? job.result : {}) as Result;

  return (
    <Dialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogContent title={T.title} description={T.lead} wide className="max-w-2xl" closeLabel={t.common.close}>
        <div data-testid="auto-video" className="flex flex-col gap-5">
          {!job || job.status === 'canceled' ? (
            <>
              <KindPicker value={kind} onChange={setKind} />
              {clips.length > 1 ? <ClipPicker clips={clips} picked={picked} onChange={setPicked} locale={locale} /> : null}
              <Field label={T.preference} hint={T.preferenceHint}>
                {(p) => (
                  <Textarea {...p} value={preference} onChange={(e) => setPreference(e.target.value)} placeholder={T.placeholder} maxLength={1000} rows={3} />
                )}
              </Field>
              {ai && ai.effective.provider === 'none' ? <PreferenceChips text={preference} /> : null}
              {ai && ai.effective.provider !== 'none' ? <TokenLine doc={doc} picked={picked} preference={preference} ai={ai.effective} /> : null}
              <p className="text-[12px] text-fg-muted" data-testid="auto-privacy">
                {aiPrivacy(t, ai?.effective)}
              </p>
              {ai?.effective.provider === 'chatgpt' ? <ChatGptPlanNote className="-mt-3" /> : null}
              {!shotCount || analysing ? (
                <p className="rounded-md bg-surface-sunken p-3 text-[13px]" role="status" data-testid="auto-warning">
                  {shotCount ? T.stillAnalysing : analysing ? T.noShotsYet : t.shots.noneVisible}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-accent-fg">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] text-fg-muted">{T.footer}</p>
                <Button variant="primary" onClick={() => void start()} loading={busy} data-testid="auto-start" disabled={!shotCount}>
                  <Sparkles />
                  {T.start}
                </Button>
              </div>
            </>
          ) : working ? (
            <div className="flex flex-col gap-3" role="status" aria-live="polite">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {jobMessage(job.message, t) || T.working}
              </div>
              <ProgressBar value={job.progress || null} label={T.working} />
              <div className="flex justify-end">
                <Button variant="secondary" onClick={() => void stop()}>
                  {T.cancel}
                </Button>
              </div>
            </div>
          ) : job.status === 'awaiting_answers' ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void answer(false);
              }}
            >
              <div>
                <h3 className="font-semibold">{T.questionsTitle}</h3>
                <p className="text-[13px] text-fg-muted">{T.questionsLead}</p>
              </div>
              <ol className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto pr-1" data-testid="auto-questions">
                {questions.map((q, i) => (
                  <li key={q.id}>
                    <Question
                      n={i + 1}
                      q={q}
                      value={answers[q.id] ?? q.default}
                      // A new answer for the question starts its shots over from that answer.
                      onChange={(v) =>
                        setAnswers((a) => {
                          const next = { ...a, [q.id]: v };
                          for (const item of q.items ?? []) delete next[shotAnswerKey(item.shotId)];
                          return next;
                        })
                      }
                    />
                    {q.items?.length ? (
                      <ShotCards
                        q={q}
                        answer={answers[q.id] ?? q.default}
                        choices={answers}
                        onChoose={(shotId, c) => setAnswers((a) => ({ ...a, [shotAnswerKey(shotId)]: c }))}
                        onFix={(shot) => {
                          onOpenChange(false);
                          ops.jumpToShot(shot);
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => void answer(true)} disabled={busy}>
                  {T.useDefaults}
                </Button>
                <Button type="submit" variant="primary" loading={busy} data-testid="auto-continue">
                  {T.continue}
                </Button>
              </div>
            </form>
          ) : job.status === 'succeeded' ? (
            <Done result={result} onAgain={reset} onOpen={() => onOpenChange(false)} />
          ) : (
            <div className="flex flex-col gap-3">
              <p role="alert" className="text-sm">
                <span className="font-semibold">{T.failed}.</span> {job.error}
              </p>
              {job.error?.includes(CHATGPT_USAGE_URL) ? <ManageUsage /> : null}
              <div className="flex justify-end">
                <Button variant="secondary" onClick={reset}>
                  {T.again}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What the rules understood of the wish (there is no AI to read the rest), as chips. */
function PreferenceChips({ text }: { text: string }) {
  const { t, f, locale } = useI18n();
  const T = t.aiPlan;
  const e = useMemo(() => explainPreference(text), [text]);
  if (!text.trim()) return null;
  const label = (c: PreferenceChip): string => {
    switch (c.key) {
      case 'kind':
        return T.kind[c.value];
      case 'goodOnly':
        return T.goodOnly;
      case 'best':
        return T.best;
      case 'template':
        return f(T.template, { name: TEMPLATES.find((x) => x.id === c.value)?.name[locale] ?? c.value });
      case 'putts':
        return T.putts[c.value];
      case 'title':
        return f(T.title, { title: c.value });
    }
  };
  const chip = 'rounded-full border px-2 py-0.5';
  return (
    <div className="-mt-2 flex flex-col gap-1.5 text-[12px]" data-testid="auto-understood" aria-live="polite">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="text-fg-muted">{e.understood.length ? T.understood : T.nothingUnderstood}</span>
        {e.understood.map((c) => (
          <span key={`${c.key}:${'value' in c ? c.value : ''}`} className={cn(chip, 'border-border-strong bg-surface-sunken')}>
            {label(c)}
          </span>
        ))}
      </p>
      {e.unknown.length ? (
        <p className="flex flex-wrap items-center gap-1.5" data-testid="auto-not-understood">
          <span className="text-fg-muted">{T.notUnderstood}</span>
          {e.unknown.map((w) => (
            <span key={w} className={cn(chip, 'border-dashed border-border text-fg-muted')}>
              {w}
            </span>
          ))}
          <span className="text-fg-muted">{T.notUnderstoodHint}</span>
        </p>
      ) : null}
    </div>
  );
}

/** About how many tokens the video will use with the AI, and a warning when the ceiling is too low. */
function TokenLine({ doc, picked, preference, ai }: { doc: Project; picked: Set<string>; preference: string; ai: AiSettingsInfo['effective'] }) {
  const { t, f, locale } = useI18n();
  const wish = useDeferredValue(preference);
  const e = useMemo(() => {
    try {
      const media = Object.fromEntries(Object.entries(doc.media).filter(([id, m]) => picked.has(id) || m.kind !== 'video'));
      const sub = { ...doc, media, clips: doc.clips.filter((c) => picked.has(c.mediaId)), shots: doc.shots.filter((s) => picked.has(s.mediaId)) };
      const s = summarize(sub);
      return videoTokenEstimate(s, wish, planFromRules(s, wish, locale), { vision: ai.vision });
    } catch {
      return null;
    }
  }, [doc, picked, wish, locale, ai.vision]);
  if (!e || !picked.size) return null;
  const n = (v: number) => (Math.ceil(v / 100) * 100).toLocaleString(locale === 'da' ? 'da-DK' : 'en-GB');
  return (
    <div className="-mt-2 text-[12px]" data-testid="auto-tokens-estimate">
      <p className="text-fg-muted">{f(t.aiPlan.dialogEstimate, { total: n(e.total) })}</p>
      {e.needed > ai.maxTokens ? (
        <p role="status" className="text-accent-fg">
          {f(t.aiPlan.dialogTooLow, { max: n(ai.maxTokens) })}
        </p>
      ) : null}
    </div>
  );
}

function ClipPicker(p: {
  clips: { id: string; name: string; recordedAt: string | null; shots: number }[];
  picked: Set<string>;
  onChange: (s: Set<string>) => void;
  locale: 'da' | 'en';
}) {
  const { t, f } = useI18n();
  const T = t.auto;
  const id = useId();
  const time = (iso: string | null) => {
    const d = iso ? new Date(iso.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleTimeString(p.locale === 'da' ? 'da-DK' : 'en-GB', { hour: '2-digit', minute: '2-digit' })
      : T.unknownTime;
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 flex w-full items-center justify-between text-[13px] font-medium">
        <span>{T.clips}</span>
        <span className="flex gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => p.onChange(new Set(p.clips.map((c) => c.id)))}>
            {T.all}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => p.onChange(new Set())}>
            {T.none}
          </Button>
        </span>
      </legend>
      <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border" data-testid="auto-clips">
        {p.clips.map((c, i) => (
          <li key={c.id} className="flex items-center gap-3 px-3 py-2">
            <Checkbox
              id={`${id}-${i}`}
              checked={p.picked.has(c.id)}
              onChange={(v) => {
                const next = new Set(p.picked);
                if (v) next.add(c.id);
                else next.delete(c.id);
                p.onChange(next);
              }}
            />
            <label htmlFor={`${id}-${i}`} className="flex min-w-0 flex-1 cursor-pointer items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{c.name}</span>
              <span className="tabular shrink-0 text-[12px] text-fg-muted">
                {time(c.recordedAt)} · {c.shots === 1 ? T.oneShot : c.shots ? f(T.shotsIn, { n: c.shots }) : T.noShots}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function Question({ n, q, value, onChange }: { n: number; q: PlanQuestion; value: string; onChange: (v: string) => void }) {
  const { t, f } = useI18n();
  const id = useId();
  return (
    <fieldset>
      <legend className="text-sm">
        <span className="sr-only">{f(t.auto.question, { n })}: </span>
        {q.text}
      </legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {q.options.map((o) => (
          <label
            key={o.id}
            htmlFor={`${id}-${o.id}`}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-sm border px-3 py-1.5 text-[13px] focus-within:ring-2 focus-within:ring-[var(--focus)]',
              value === o.id ? 'border-accent bg-surface-sunken' : 'border-border hover:bg-surface-sunken',
            )}
          >
            <input
              id={`${id}-${o.id}`}
              type="radio"
              name={id}
              value={o.id}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
              className="accent-[var(--accent)]"
            />
            {o.label}
            {o.id === q.default ? <span className="text-[11px] text-fg-muted">({t.auto.defaultTag})</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Whether a question's answer keeps a shot; null when it depends on more than the answer ("only the best"). */
function keptByAnswer(q: PlanQuestion, answer: string, shotId: string): ShotChoice | null {
  if (q.id === 'doubtful') return answer === 'drop' ? 'drop' : 'keep';
  if (answer === 'both') return 'keep';
  if (q.id.startsWith('retake:') && answer === 'last') return shotId === q.shotIds[0] ? 'drop' : 'keep';
  if (q.id.startsWith('same:') && answer.startsWith('keep:')) return answer.slice(5) === shotId ? 'keep' : 'drop';
  // N putts: the last N found are kept (see prepare in @golf/compose).
  if (q.id.startsWith('putts:'))
    return answer === 'notHoled' || answer === '4' || q.shotIds.indexOf(shotId) >= q.shotIds.length - Number(answer) ? 'keep' : 'drop';
  return null;
}

function ShotCards(p: {
  q: PlanQuestion;
  answer: string;
  choices: Record<string, string>;
  onChoose: (shotId: string, c: ShotChoice) => void;
  onFix: (shot: Shot) => void;
}) {
  const { t } = useI18n();
  return (
    <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label={t.auto.shotsAsked}>
      {(p.q.items ?? []).map((item) => {
        const own = p.choices[shotAnswerKey(item.shotId)];
        const choice = own === 'keep' || own === 'drop' ? own : keptByAnswer(p.q, p.answer, item.shotId);
        return (
          <li key={item.shotId}>
            <ShotCard item={item} choice={choice} onChoose={(c) => p.onChoose(item.shotId, c)} onFix={p.onFix} />
          </li>
        );
      })}
    </ul>
  );
}

function ShotCard({
  item,
  choice,
  onChoose,
  onFix,
}: {
  item: PlanItem;
  choice: ShotChoice | null;
  onChoose: (c: ShotChoice) => void;
  onFix: (shot: Shot) => void;
}) {
  const { t, f } = useI18n();
  const T = t.auto;
  const shot = useEditor((s) => s.doc.shots.find((x) => x.id === item.shotId));
  const place = f(T.at, { n: item.clip, time: clock(item.t) });
  const toggle = (c: ShotChoice, label: string, text: string) => (
    <Button
      type="button"
      size="sm"
      variant={choice === c ? (c === 'drop' ? 'danger' : 'primary') : 'secondary'}
      aria-pressed={choice === c}
      aria-label={f(label, { place })}
      onClick={() => onChoose(c)}
    >
      {choice === c ? <Check aria-hidden /> : null}
      {text}
    </Button>
  );
  return (
    <article
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-md border bg-surface',
        choice === 'drop' ? 'border-border opacity-80' : 'border-border-strong',
      )}
      aria-label={place}
      data-testid="auto-shot"
    >
      <ShotLoop item={item} shot={shot} label={f(T.loopLabel, { place })} />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="tabular text-[13px] font-semibold">
          {place}
          <span className="ml-1 font-normal text-fg-muted">{item.clipName}</span>
        </p>
        {item.reasons.length ? (
          <ul className="list-disc pl-4 text-[12px] text-fg-muted">
            {item.reasons.map((r) => (
              <li key={r}>{f(T.reasons[r], { next: item.nextM ?? '?', carry: item.carryM ?? '?' })}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {toggle('keep', T.keepShotLabel, T.keepShot)}
          {toggle('drop', T.removeShotLabel, T.removeShot)}
          <Button type="button" size="sm" variant="ghost" disabled={!shot} aria-label={f(T.fixInEditorLabel, { place })} onClick={() => shot && onFix(shot)}>
            <SquarePen aria-hidden />
            {T.fixInEditor}
          </Button>
        </div>
      </div>
    </article>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** About 3 s around the strike (1 s before, 2 s after), looped and muted, with the tracer's path on top. */
function ShotLoop({ item, shot, label }: { item: PlanItem; shot: Shot | undefined; label: string }) {
  const { t } = useI18n();
  const m = useEditor((s) => s.media[item.mediaId]);
  const doc = useEditor((s) => s.doc.media[item.mediaId]);
  const src = m?.urls.proxy ?? m?.urls.original;
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [wanted, setWanted] = useState<boolean | null>(null);
  const from = Math.max(0, item.t - 1);
  const to = item.t + 2;
  // Plays by itself only while on screen and when the user has not asked for less motion.
  const play = wanted ?? !reduced;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let visible = false;
    const sync = () => {
      if (play && visible) void v.play().catch(() => {});
      else v.pause();
    };
    const ready = () => {
      v.currentTime = play ? from : item.t;
      sync();
    };
    const loop = () => {
      if (v.currentTime >= to || v.currentTime < from - 0.25) v.currentTime = from;
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    io.observe(v);
    if (v.readyState >= 1) ready();
    v.addEventListener('loadedmetadata', ready);
    v.addEventListener('timeupdate', loop);
    return () => {
      io.disconnect();
      v.removeEventListener('loadedmetadata', ready);
      v.removeEventListener('timeupdate', loop);
    };
  }, [play, from, to, item.t, src]);

  const path = useMemo(() => {
    const sp = shot && shot.kind === 'full' ? sourcePath(shot) : null;
    if (!sp) return '';
    const step = Math.max(1, Math.floor(sp.n / 60));
    const pts: string[] = [];
    for (let i = 0; i < sp.n; i += step) pts.push(`${sp.u[i].toFixed(1)},${sp.v[i].toFixed(1)}`);
    return pts.join(' ');
  }, [shot]);

  if (!src) return <div className="flex aspect-video items-center justify-center bg-surface-sunken text-[12px] text-fg-muted">{t.auto.noPreview}</div>;
  return (
    <div className="relative aspect-video bg-black">
      <video
        ref={ref}
        src={`${src}#t=${item.t.toFixed(2)}`}
        muted
        playsInline
        preload="metadata"
        aria-label={label}
        className="absolute inset-0 size-full object-contain"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {path && doc ? (
        <svg
          viewBox={`0 0 ${doc.width} ${doc.height}`}
          preserveAspectRatio="xMidYMid meet"
          className="pointer-events-none absolute inset-0 size-full"
          aria-hidden
        >
          <polyline
            points={path}
            fill="none"
            stroke={shot?.style.color ?? '#ff3b30'}
            strokeWidth={Math.max(doc.width, doc.height) * 0.006}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
          />
        </svg>
      ) : null}
      <Button
        type="button"
        size="iconSm"
        variant="secondary"
        className="absolute right-2 bottom-2 opacity-90"
        aria-label={playing ? t.auto.pause : t.auto.play}
        onClick={() => setWanted(!playing)}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </Button>
    </div>
  );
}

function Done({ result, onAgain, onOpen }: { result: Result; onAgain: () => void; onOpen: () => void }) {
  const { t, f } = useI18n();
  const T = t.auto;
  const [copied, setCopied] = useState(false);
  const projects = result.projects ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="auto-done">
      <div className="flex items-center gap-3">
        <Birdie mood={projects.length ? 'cheer' : 'confused'} size={48} className="shrink-0" />
        <div>
          <h3 className="font-semibold">{projects.length > 1 ? f(T.doneMany, { n: projects.length }) : projects.length ? T.doneTitle : T.noVideo}</h3>
          <p className="text-[13px] text-fg-muted">{projects.length ? T.doneNext : T.noVideoHint}</p>
        </div>
      </div>
      {projects.length ? (
        <ul className="flex flex-col gap-2">
          {projects.map((p, i) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <span className="truncate">{p.name}</span>
              <Button asChild size="sm" variant={i === 0 ? 'primary' : 'secondary'}>
                <Link href={`/app/projects/${p.id}`} aria-label={`${T.openProject}: ${p.name}`} onClick={onOpen}>
                  <ExternalLink />
                  {T.openProject}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {result.notes?.length ? (
        <ul className="list-disc pl-5 text-[13px] text-fg-muted">
          {result.notes.map((n) => (
            <li key={n}>
              {n}
              {n.includes(CHATGPT_USAGE_URL) ? (
                <>
                  {' '}
                  <ManageUsage />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {result.usage && result.ai ? (
        <p className="tabular text-[12px] text-fg-muted" data-testid="auto-tokens">
          {f(T.tokensUsed, { calls: result.usage.calls, input: result.usage.inputTokens, output: result.usage.outputTokens, model: result.ai.model })}
        </p>
      ) : null}
      {result.description ? (
        <Field label={T.description}>
          {(p) => (
            <div className="flex flex-col gap-2">
              <Textarea {...p} readOnly value={result.description} rows={4} />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="self-end"
                onClick={() => {
                  void navigator.clipboard?.writeText(result.description ?? '');
                  setCopied(true);
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? T.copied : T.copy}
              </Button>
            </div>
          )}
        </Field>
      ) : null}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onAgain}>
          {T.again}
        </Button>
      </div>
    </div>
  );
}

type Kind = 'youtube' | 'highlight' | 'shorts';

/** The three kinds of video as cards (a radio group); the free text below adds to the pick. */
function KindPicker({ value, onChange }: { value: Kind; onChange: (k: Kind) => void }) {
  const { t } = useI18n();
  const T = t.make;
  const name = useId();
  const kinds: { id: Kind; icon: ReactNode; title: string; text: string }[] = [
    { id: 'youtube', icon: <MonitorPlay className="size-6" />, title: T.youtube, text: T.youtubeHint },
    { id: 'highlight', icon: <Smartphone className="size-6" />, title: T.highlight, text: T.highlightHint },
    { id: 'shorts', icon: <Clapperboard className="size-6" />, title: T.perShot, text: T.perShotHint },
  ];
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium">{t.auto.format}</legend>
      <div className="grid gap-2 sm:grid-cols-3" data-testid="auto-kinds">
        {kinds.map((k) => (
          <label
            key={k.id}
            className={cn(
              'flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-surface p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-[var(--focus)] hover:bg-surface-sunken',
              value === k.id ? 'border-2 border-accent' : 'border-border',
            )}
          >
            <input type="radio" name={name} value={k.id} checked={value === k.id} onChange={() => onChange(k.id)} className="sr-only" />
            <span className={cn(value === k.id ? 'text-accent-fg' : 'text-fg-muted')} aria-hidden>
              {k.icon}
            </span>
            <span className="text-sm font-semibold">{k.title}</span>
            <span className="text-[12px] leading-snug text-fg-muted">{k.text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
