import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { middleware } from '../src/middleware';

const rewriteOf = (url: string) => middleware(new NextRequest(url)).headers.get('x-middleware-rewrite');

describe('the /api proxy when the API runs on another port', () => {
  afterEach(() => {
    delete process.env.API_URL;
  });

  it('leaves /api to the rewrite fixed at build time when API_URL is not set', () => {
    expect(rewriteOf('http://localhost:3000/api/health')).toBeNull();
  });

  it('sends /api to API_URL, read when the request comes in', () => {
    process.env.API_URL = 'http://127.0.0.1:8001';
    expect(rewriteOf('http://localhost:3001/api/projects/p1?x=1')).toBe('http://127.0.0.1:8001/api/projects/p1?x=1');
  });

  it('never forwards /api/internal', () => {
    process.env.API_URL = 'http://127.0.0.1:8001';
    expect(rewriteOf('http://localhost:3001/api/internal/jobs/claim')).toBeNull();
  });
});
