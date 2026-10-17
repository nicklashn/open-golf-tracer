'use client';

import { refitShot, type RefitOptions } from '@golf/physics';
import type { Shot } from '@golf/schema';

export interface RefitResult {
  params: number[];
  ms: number;
  rmsPx: number | null;
  lambda: number;
  converged: boolean;
}

/**
 * Latest-wins refit queue on a Web Worker: while a fit runs, only the newest request per shot
 * waits, so the handle never lags behind the pointer. "Latest" is per shot: a fit of another
 * shot (a constraint or club changed on one, a handle dragged on the next) never cancels it.
 */
export class Refitter {
  private worker: Worker | null = null;
  private seq = 0;
  private busy = false;
  private pending = new Map<string, { shot: Shot; opts: RefitOptions; resolve: (r: RefitResult | null) => void }>();
  private current: { id: number; resolve: (r: RefitResult | null) => void } | null = null;

  private ensure(): Worker | null {
    if (this.worker || typeof Worker === 'undefined') return this.worker;
    try {
      this.worker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const d = e.data as { id: number; ok: boolean } & RefitResult;
        if (this.current && d.id === this.current.id) this.current.resolve(d.ok ? d : null);
        this.current = null;
        this.busy = false;
        this.pump();
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private pump(): void {
    if (this.busy || !this.pending.size) return;
    const [key, job] = this.pending.entries().next().value!;
    this.pending.delete(key);
    const w = this.ensure();
    if (!w) {
      // No worker support: compute inline (still correct, just on the main thread).
      const r = refitShot(job.shot, job.opts);
      job.resolve({ params: r.params, ms: r.ms, rmsPx: r.rmsPx, lambda: r.lambda, converged: r.converged });
      return this.pump();
    }
    this.busy = true;
    const id = ++this.seq;
    this.current = { id, resolve: job.resolve };
    w.postMessage({ id, shot: job.shot, opts: job.opts });
  }

  request(shot: Shot, opts: RefitOptions): Promise<RefitResult | null> {
    return new Promise((resolve) => {
      // A newer request for the same shot supersedes the waiting one (it resolves with null).
      this.pending.get(shot.id)?.resolve(null);
      this.pending.set(shot.id, { shot: JSON.parse(JSON.stringify(shot)), opts, resolve });
      this.pump();
    });
  }
}

export const refitter = new Refitter();
