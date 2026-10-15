'use client';

/**
 * "Make a video for me": pick clips, write a preference, and the server's compose job edits the
 * video. When the rules are unsure it asks once, with every question on one screen and the
 * default answer already picked; otherwise it runs to the end on its own.
 */
import type { PlanQuestion } from '@golf/compose';
import { Check, Copy, ExternalLink, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { ProgressBar } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { aiPrivacy, type AiSettingsInfo } from '@/components/app/AiSettings';
import { useJobEvents, type JobInfo } from '@/lib/events';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import { saveNow } from './autosave';
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
      setJob(await api<JobInfo>('/autovideo', { body: { projectId, preference, locale, names: t.layers.types, mediaIds } }));
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
      const body = useDefaults ? {} : answers;
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
              <ClipPicker clips={clips} picked={picked} onChange={setPicked} locale={locale} />
              <Field label={T.preference} hint={T.preferenceHint}>
                {(p) => (
                  <Textarea {...p} value={preference} onChange={(e) => setPreference(e.target.value)} placeholder={T.placeholder} maxLength={1000} rows={3} />
                )}
              </Field>
              <p className="text-[12px] text-fg-muted" data-testid="auto-privacy">
                {aiPrivacy(t, ai?.effective)}
              </p>
              {error ? (
                <p role="alert" className="text-sm text-accent-fg">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => void start()} loading={busy} data-testid="auto-start">
                  <Sparkles />
                  {T.start}
                </Button>
              </div>
            </>
          ) : working ? (
            <div className="flex flex-col gap-3" role="status" aria-live="polite">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {job.message || T.working}
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
                    <Question n={i + 1} q={q} value={answers[q.id] ?? q.default} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
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
            <Done result={result} onAgain={reset} />
          ) : (
            <div className="flex flex-col gap-3">
              <p role="alert" className="text-sm">
                <span className="font-semibold">{T.failed}.</span> {job.error}
              </p>
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

function Done({ result, onAgain }: { result: Result; onAgain: () => void }) {
  const { t, f } = useI18n();
  const T = t.auto;
  const [copied, setCopied] = useState(false);
  const projects = result.projects ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="auto-done">
      <h3 className="font-semibold">{projects.length > 1 ? f(T.doneMany, { n: projects.length }) : projects.length ? T.doneTitle : T.noVideo}</h3>
      {projects.length ? (
        <ul className="flex flex-col gap-2">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <span className="truncate">{p.name}</span>
              <Button asChild size="sm" variant="secondary">
                <Link href={`/app/projects/${p.id}`}>
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
            <li key={n}>{n}</li>
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
