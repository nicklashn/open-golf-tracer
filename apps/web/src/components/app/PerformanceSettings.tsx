'use client';

/**
 * Settings → Performance: the worker's profile (how many analyses/videos at once, detector
 * sessions, CPU threads), the hardware it sees, and "Optimise" – a short benchmark job that saves
 * the fastest safe settings as "Tuned for this PC". The worker reads the profile before each job.
 * A running Optimise is picked up again when the page opens; "Details" lists every step it tried
 * (with the error of a failed one, for a bug report).
 */
import { Gauge } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import type { JobInfo } from '@/lib/events';
import { number, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';

type Profile = 'gentle' | 'balanced' | 'max' | 'tuned';
type Device = 'DirectML' | 'CUDA' | 'CPU';

interface Perf {
  analyses: number;
  ingests: number;
  sessions: number;
  batch: number;
  threads: number;
  gpu: boolean;
  /** How videos are decoded for analysis: 'sw' (CPU), 'auto' (ffmpeg picks) or a GPU decoder. */
  decoder?: string;
}

interface Trial {
  kind?: 'detector' | 'decode';
  sessions: number;
  batch: number;
  callers?: number;
  fps: number | null;
  vram_mb: number | null;
  error: string | null;
  provider?: string | null;
  decoder?: string | null;
}

interface TuneSummary {
  speedup: number;
  inference: Device;
  gpu: string | null;
  vramMb: number | null;
  stop: 'vram' | 'error' | 'no_gain' | 'time' | 'cpu' | 'done';
  trials?: Trial[];
  decoder?: string | null;
  decodeFps?: number | null;
}

export interface PerformanceInfo {
  profile: Profile;
  effective: Perf;
  profiles: Partial<Record<Profile, Perf>>;
  tuned: { summary: TuneSummary; at: string } | null;
  fallback: { at: string; from: string; to: Profile | 'cpu'; reason: string } | null;
  cpuOnly: boolean;
  decodeFailed?: { method: string; codec: string; at: string | null }[];
  ingestFromEnv: boolean;
  hardware: {
    cpuCores: number;
    ram: { totalMb: number; availableMb: number };
    gpus: { name: string; vramMb: number; usedMb: number }[];
    inference: Device;
  };
}

const ORDER: Profile[] = ['gentle', 'balanced', 'max', 'tuned'];
const gb = (mb: number) => Math.round(mb / 1024);

export function PerformanceSettings() {
  const { t, f, locale } = useI18n();
  const T = t.perf;
  const [info, setInfo] = useState<PerformanceInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void api<PerformanceInfo>('/performance').then(setInfo, (e) => setError(errorMessage(e, t)));
    // An Optimise started earlier (the page was left meanwhile) is followed again.
    void api<{ jobs: JobInfo[] }>('/jobs?active=true').then(
      ({ jobs }) => {
        const running = jobs.find((x) => x.kind === 'tune');
        if (running) void follow(running);
      },
      () => undefined,
    );
    return () => {
      alive.current = false;
    };
    // Once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function choose(profile: Profile) {
    setSaving(true);
    try {
      setInfo(await api<PerformanceInfo>('/performance', { method: 'PUT', body: { profile } }));
      toast.success(T.saved);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setSaving(false);
    }
  }

  /** Polls the Optimise job until it ends. It takes 1–2 min once it runs, but waits for the
   *  analyses already running (a round of clips can take a while), so there is no time limit. */
  async function follow(start: JobInfo) {
    let j: JobInfo | undefined = start;
    setJob(j);
    try {
      while (alive.current && j && (j.status === 'queued' || j.status === 'running')) {
        await new Promise((r) => setTimeout(r, 1000));
        const { jobs } = await api<{ jobs: JobInfo[] }>('/jobs');
        j = jobs.find((x) => x.id === start.id);
        if (j) setJob(j);
      }
      if (!alive.current) return;
      if (j?.status === 'succeeded') setInfo(await api<PerformanceInfo>('/performance?refresh=true'));
      else if (j?.status === 'canceled') setError(T.canceled);
      else setError(`${T.failed}${j?.error ? `: ${j.error}` : ''}`);
    } catch (e) {
      if (alive.current) setError(`${T.failed}: ${errorMessage(e, t)}`);
    } finally {
      if (alive.current) setJob(null);
    }
  }

  async function optimize() {
    setError('');
    try {
      await follow(await api<JobInfo>('/performance/optimize', { method: 'POST' }));
    } catch (e) {
      setError(`${T.failed}: ${errorMessage(e, t)}`);
    }
  }

  async function stop() {
    if (!job) return;
    try {
      await api(`/jobs/${job.id}/cancel`, { method: 'POST' });
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }

  if (!info) return error ? <p className="text-sm text-accent-fg">{error}</p> : null;
  const hw = info.hardware;
  const gpu = hw.gpus[0];
  const tuned = info.tuned?.summary;
  const label = (p: Profile | 'cpu') => (p === 'cpu' ? T.cpuLabel : T.profiles[p]);

  function decoderName(d: string) {
    return d === 'sw' ? T.decoderCpu : d === 'auto' ? T.decoderAuto : f(T.decoderGpu, { name: d });
  }

  function trialText(tr: Trial) {
    const n = tr.callers ?? 1;
    const what =
      tr.kind === 'decode'
        ? tr.decoder
          ? f(T.trialDecoder, { how: decoderName(tr.decoder), n })
          : f(T.trialDecode, { n })
        : f(T.trial, { sessions: tr.sessions, batch: tr.batch, callers: n }) + (tr.provider ? ` (${tr.provider})` : '');
    if (tr.error) return `${what}: ${T.trialFailed}`;
    const fps = f(T.trialFps, { fps: number(tr.fps ?? 0, locale, 1) });
    return `${what}: ${fps}${tr.vram_mb ? ` · ${f(T.trialVram, { mb: tr.vram_mb })}` : ''}`;
  }

  function does(p: Perf) {
    return (
      f(T.does, {
        analyses: p.analyses === 1 ? T.analysesOne : f(T.analyses, { n: p.analyses }),
        ingests: p.ingests === 1 ? T.ingestsOne : f(T.ingests, { n: p.ingests }),
        threads: p.threads ? f(T.someCores, { n: p.threads }) : T.allCores,
      }) +
      (hw.inference !== 'CPU' && p.sessions > 1 ? ` · ${f(T.sessions, { n: p.sessions })}` : '') +
      (p.decoder && p.decoder !== 'auto' ? ` · ${f(T.decodes, { how: decoderName(p.decoder) })}` : '')
    );
  }

  /** nvidia-smi names NVIDIA cards only; on AMD/Intel the ball search still runs on the card (DirectML). */
  const gpuLine = gpu
    ? f(T.gpu, { name: gpu.name, gb: gb(gpu.vramMb) })
    : info.cpuOnly || hw.inference === 'CPU'
      ? T.noGpu
      : f(T.gpuVia, { device: tuned?.gpu || T.gpuUnnamed, provider: hw.inference });

  return (
    <div className="grid max-w-xl gap-5" data-testid="performance-settings">
      <div className="rounded-md border border-border p-4 text-[13px]">
        <h3 className="mb-1 text-sm font-semibold">{T.hardware}</h3>
        <ul className="grid gap-0.5 text-fg-muted">
          <li>
            {f(T.cpu, { n: hw.cpuCores })}
            {hw.ram.totalMb ? ` · ${f(T.ram, { gb: gb(hw.ram.totalMb) })}` : ''}
          </li>
          <li data-testid="perf-gpu">{gpuLine}</li>
          <li>{f(T.inference, { device: T.devices[info.cpuOnly ? 'CPU' : hw.inference] })}</li>
        </ul>
      </div>

      {info.fallback ? (
        <p role="status" className="text-[13px] text-accent-fg">
          {f(T.fallback, { to: label(info.fallback.to), when: relativeTime(info.fallback.at, locale) })}
        </p>
      ) : null}
      {info.cpuOnly ? (
        <p role="status" className="text-[13px] text-accent-fg">
          {T.cpuOnly}
        </p>
      ) : null}
      {(info.decodeFailed ?? []).map((d) => (
        <p key={`${d.method}:${d.codec}`} role="status" className="text-[13px] text-accent-fg" data-testid="perf-decode-failed">
          {f(T.decodeFailed, {
            method: d.method,
            codec: d.codec.toUpperCase(),
            when: d.at ? relativeTime(d.at, locale) : '',
          })}
        </p>
      ))}

      <fieldset className="grid gap-2" disabled={saving}>
        <legend className="mb-1.5 text-[13px] font-medium">{T.profile}</legend>
        {ORDER.filter((p) => info.profiles[p]).map((p) => {
          const id = `perf-${p}`;
          const checked = info.profile === p;
          return (
            <div
              key={p}
              className={cn(
                'flex gap-3 rounded-md border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus)]',
                checked ? 'border-accent bg-surface-raised' : 'border-border hover:border-border-strong',
              )}
            >
              <input
                id={id}
                type="radio"
                name="perf-profile"
                value={p}
                checked={checked}
                onChange={() => void choose(p)}
                className="mt-1 accent-[var(--accent)]"
                aria-describedby={`${id}-d`}
              />
              <div className="grid gap-0.5">
                <label htmlFor={id} className="cursor-pointer text-sm font-medium">
                  {T.profiles[p]}
                </label>
                <p id={`${id}-d`} className="text-[13px] text-fg-muted">
                  {T.explain[p]} <span className="text-fg-subtle">{does(info.profiles[p]!)}</span>
                </p>
              </div>
            </div>
          );
        })}
      </fieldset>
      {info.ingestFromEnv ? <p className="text-[12px] text-fg-muted">{T.envIngest}</p> : null}

      <div className="grid gap-2">
        <p className="text-[13px] text-fg-muted">{T.optimizeLead}</p>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => void optimize()} loading={!!job} disabled={!!job}>
            <Gauge />
            {job ? T.optimizing : T.optimize}
          </Button>
          {job ? (
            <Button type="button" variant="ghost" onClick={() => void stop()}>
              {T.stopOptimize}
            </Button>
          ) : null}
        </div>
        {job ? (
          <div className="grid gap-1" aria-live="polite">
            <ProgressBar value={job.status === 'running' ? job.progress : null} label={T.optimizing} />
            <p className="text-[12px] text-fg-muted">{job.message}</p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-accent-fg">
            {error}
          </p>
        ) : null}
        {tuned && !job ? (
          <p role="status" className="text-sm" data-testid="perf-result">
            {f(T.result, { x: number(tuned.speedup, locale, 1) })}{' '}
            {tuned.inference !== 'CPU' && tuned.gpu
              ? f(T.resultGpu, { gpu: tuned.gpu, n: info.profiles.tuned?.analyses ?? 1 })
              : f(T.resultCpu, { n: info.profiles.tuned?.analyses ?? 1 })}{' '}
            {tuned.decoder && tuned.decodeFps ? `${f(T.resultDecode, { how: decoderName(tuned.decoder), fps: number(tuned.decodeFps, locale, 0) })} ` : ''}
            {T.stop[tuned.stop]} {info.tuned ? f(T.measuredAt, { when: relativeTime(info.tuned.at, locale) }) : ''}
          </p>
        ) : null}
        {tuned?.trials?.length && !job ? (
          <details className="text-[12px] text-fg-muted" data-testid="perf-details">
            <summary className="cursor-pointer select-none">{T.details}</summary>
            <ol className="mt-1 grid gap-1 pl-4">
              {tuned.trials.map((tr, i) => (
                <li key={i} className="list-decimal">
                  {trialText(tr)}
                  {tr.error ? <pre className="mt-0.5 whitespace-pre-wrap break-all text-accent-fg">{tr.error}</pre> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
    </div>
  );
}
