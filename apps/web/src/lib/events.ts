'use client';

import { useEffect, useRef } from 'react';

function report(e: unknown) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(e);
  else console.error(e);
}

export interface JobInfo {
  id: string;
  kind: 'ingest' | 'analyze' | 'retrack' | 'export' | 'compose' | 'tune' | 'ai_test';
  status: 'queued' | 'running' | 'awaiting_answers' | 'succeeded' | 'failed' | 'canceled';
  progress: number;
  message: string;
  projectId: string | null;
  mediaId: string | null;
  error: string;
  /** A stable code for a known failure (e.g. 'disk_full'), translated under t.errors. */
  errorCode?: string;
  result: Record<string, unknown>;
}

export interface JobEvent {
  type: 'job';
  job: JobInfo;
  media?: unknown;
  shots?: unknown[];
  /** Course/hole found from the video's GPS (analysis done), with the GPS itself. */
  place?: { mediaId: string; geo?: { lat: number; lon: number; acc?: number } } & Record<string, unknown>;
  export?: { id: string; url: string; previewUrl?: string; projectName: string };
}

/**
 * Server-Sent Events with job progress. Reconnects automatically. `projectId` narrows them to
 * one project; null means "not yet" (nothing is subscribed), undefined all of the user's jobs.
 * A handler that throws is reported, not swallowed: only a malformed message is skipped.
 * A new connection only sends jobs that are still active, so `onReconnect` runs then (not on
 * the first connection) for the caller to fetch what changed while it was away – a job that
 * finished or failed meanwhile.
 */
export function useJobEvents(onEvent: (e: JobEvent) => void, projectId?: string | null, onReconnect?: () => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const re = useRef(onReconnect);
  re.current = onReconnect;
  useEffect(() => {
    if (projectId === null) return;
    const url = `/api/events${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`;
    let es: EventSource | null = null;
    let closed = false;
    let lost = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      es = new EventSource(url, { withCredentials: true });
      es.onopen = () => {
        if (lost) re.current?.();
        lost = false;
      };
      es.addEventListener('job', (m) => {
        let ev: JobEvent;
        try {
          ev = JSON.parse((m as MessageEvent).data);
        } catch {
          return; // malformed
        }
        try {
          cb.current(ev);
        } catch (e) {
          // Shown in the console and to error reporting; the stream itself keeps going.
          report(e);
        }
      });
      es.onerror = () => {
        lost = true;
        es?.close();
        if (!closed) retry = setTimeout(open, 3000);
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [projectId]);
}
