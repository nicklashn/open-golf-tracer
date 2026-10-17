'use client';

/**
 * Clips whose last analysis failed, so the Shots panel can keep a "Try again" next to each one
 * (a toast alone is gone after 20 s). Filled from the project's job history when the editor opens
 * and kept up to date from the job events; a new analysis of the clip clears it.
 */
import { create } from 'zustand';
import type { JobInfo } from '@/lib/events';

export interface AnalysisFailure {
  jobId: string;
  error: string;
}

interface State {
  byMedia: Record<string, AnalysisFailure>;
}

export const useAnalysisFailures = create<State>(() => ({ byMedia: {} }));

/** From the project's jobs, newest first (GET /jobs?project_id=…): clips whose latest analysis failed. */
export function failuresFromJobs(jobs: Pick<JobInfo, 'id' | 'kind' | 'status' | 'mediaId' | 'error'>[]): Record<string, AnalysisFailure> {
  const seen = new Set<string>();
  const out: Record<string, AnalysisFailure> = {};
  for (const j of jobs) {
    if (j.kind !== 'analyze' || !j.mediaId || seen.has(j.mediaId)) continue;
    seen.add(j.mediaId);
    if (j.status === 'failed') out[j.mediaId] = { jobId: j.id, error: j.error ?? '' };
  }
  return out;
}

export function setFailures(byMedia: Record<string, AnalysisFailure>) {
  useAnalysisFailures.setState({ byMedia });
}

/** An analysis job changed: a failure is remembered, anything newer for the clip clears it. */
export function noteAnalysisJob(job: Pick<JobInfo, 'id' | 'status' | 'mediaId' | 'error'>) {
  if (!job.mediaId) return;
  const cur = useAnalysisFailures.getState().byMedia;
  if (job.status === 'failed') {
    useAnalysisFailures.setState({ byMedia: { ...cur, [job.mediaId]: { jobId: job.id, error: job.error ?? '' } } });
  } else if (cur[job.mediaId] && cur[job.mediaId].jobId !== job.id) {
    const { [job.mediaId]: _gone, ...rest } = cur;
    useAnalysisFailures.setState({ byMedia: rest });
  }
}

export function clearFailure(mediaId: string) {
  const { [mediaId]: _gone, ...rest } = useAnalysisFailures.getState().byMedia;
  useAnalysisFailures.setState({ byMedia: rest });
}
