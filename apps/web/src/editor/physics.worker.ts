/// <reference lib="webworker" />
/* Runs the flight refit off the main thread so dragging handles stays at 60 fps. */
import { refitShot, type RefitOptions } from '@golf/physics';
import type { Shot } from '@golf/schema';

export interface RefitRequest {
  id: number;
  shot: Shot;
  opts: RefitOptions;
}

self.onmessage = (e: MessageEvent<RefitRequest>) => {
  const { id, shot, opts } = e.data;
  try {
    const r = refitShot(shot, opts);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, params: r.params, ms: r.ms, rmsPx: r.rmsPx, lambda: r.lambda, converged: r.converged });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, error: String(err) });
  }
};
