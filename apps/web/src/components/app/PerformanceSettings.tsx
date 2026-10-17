'use client';

/**
 * Settings → Performance: the worker's profile (how many analyses/videos at once, detector
 * sessions, CPU threads), the hardware it sees, and "Optimise" – a short benchmark job that saves
 * the fastest safe settings as "Tuned for this PC". The worker reads the profile before each job.
 */
import { Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
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
}

interface TuneSummary {
  speedup: number;
  inference: Device;
  gpu: string | null;
  vramMb: number | null;
  stop: 'vram' | 'error' | 'no_gain' | 'time' | 'cpu' | 'done';
}

export interface PerformanceInfo {
  profile: Profile;
  effective: Perf;
  profiles: Partial<Record<Profile, Perf>>;
  tuned: { summary: TuneSummary; at: string } | null;
  fallback: { at: string; from: string; to: Profile | 'cpu'; reason: string } | null;
  cpuOnly: boolean;
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

  useEffect(() => {
    void api<PerformanceInfo>('/performance').then(setInfo, (e) => setError(errorMessage(e, t)));
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

  async function optimize() {
    setError('');
    try {
      let j = await api<JobInfo>('/performance/optimize', { method: 'POST' });
      setJob(j);
      // The benchmark takes 30–60 s, longer while another analysis holds the queue.
      for (let i = 0; i < 600 && (j.status === 'queued' || j.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { jobs } = await api<{ jobs: JobInfo[] }>('/jobs');
        j = jobs.find((x) => x.id === j.id) ?? j;
        setJob(j);
      }
      if (j.status === 'succeeded') setInfo(await api<PerformanceInfo>('/performance?refresh=true'));
      else setError(`${T.failed}${j.error ? `: ${j.error}` : ''}`);
    } catch (e) {
      setError(`${T.failed}: ${errorMessage(e, t)}`);
    } finally {
      setJob(null);
    }
  }

  if (!info) return error ? <p className="text-sm text-accent-fg">{error}</p> : null;
  const hw = info.hardware;
  const gpu = hw.gpus[0];
  const tuned = info.tuned?.summary;
  const label = (p: Profile | 'cpu') => (p === 'cpu' ? T.cpuLabel : T.profiles[p]);

  function does(p: Perf) {
    return (
      f(T.does, {
        analyses: p.analyses === 1 ? T.analysesOne : f(T.analyses, { n: p.analyses }),
        ingests: p.ingests === 1 ? T.ingestsOne : f(T.ingests, { n: p.ingests }),
        threads: p.threads ? f(T.someCores, { n: p.threads }) : T.allCores,
      }) + (hw.inference !== 'CPU' && p.sessions > 1 ? ` · ${f(T.sessions, { n: p.sessions })}` : '')
    );
  }

  return (
    <div className="grid max-w-xl gap-5" data-testid="performance-settings">
      <div className="rounded-md border border-border p-4 text-[13px]">
        <h3 className="mb-1 text-sm font-semibold">{T.hardware}</h3>
        <ul className="grid gap-0.5 text-fg-muted">
          <li>
            {f(T.cpu, { n: hw.cpuCores })}
            {hw.ram.totalMb ? ` · ${f(T.ram, { gb: gb(hw.ram.totalMb) })}` : ''}
          </li>
          <li>{gpu ? f(T.gpu, { name: gpu.name, gb: gb(gpu.vramMb) }) : T.noGpu}</li>
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
        <div>
          <Button type="button" variant="secondary" onClick={() => void optimize()} loading={!!job} disabled={!!job}>
            <Gauge />
            {job ? T.optimizing : T.optimize}
          </Button>
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
            {T.stop[tuned.stop]} {info.tuned ? f(T.measuredAt, { when: relativeTime(info.tuned.at, locale) }) : ''}
          </p>
        ) : null}
      </div>
    </div>
  );
}
