import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLog, prune, redact } from '../applog.mjs';
import cases from './redact-cases.json';

const FAKE_KEY = 'sk-ant-api03-PLANTEDFAKEKEY0123456789abcdef';

describe('redact (same cases as golf_api/redact.py)', () => {
  for (const c of cases.cases as { in: string; secret?: string; keep?: string }[]) {
    it(c.in.slice(0, 40), () => {
      const out: string = redact(c.in);
      if (c.secret) {
        expect(out).not.toContain(c.secret);
        expect(out).toContain('[redacted]');
      }
      if (c.keep) expect(out).toContain(c.keep);
    });
  }

  it('masks known secrets whatever their shape', () => {
    expect(redact('token is plainvalue42 ok', ['plainvalue42'])).toBe('token is [redacted] ok');
  });
});

describe('log file', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'ogt-log-'));

  it('writes one redacted, colour-free file per day', () => {
    const dir = tmp();
    let now = new Date(2026, 9, 17, 12, 0, 0);
    const log = createLog(dir, { secrets: ['my-internal-token-123'], clock: () => now });
    log.write('api', `\x1b[32mINFO\x1b[0m Authorization: Bearer ${FAKE_KEY}`);
    log.write('exporter', 'claim with my-internal-token-123 failed');
    now = new Date(2026, 9, 18, 0, 0, 1);
    log.write('web', 'next day');
    expect(readdirSync(dir).sort()).toEqual(['app-20261017.log', 'app-20261018.log']);
    const day1 = readFileSync(join(dir, 'app-20261017.log'), 'utf8');
    expect(day1).not.toContain('PLANTED');
    expect(day1).not.toContain('my-internal-token-123');
    expect(day1).not.toContain('\x1b[');
    expect(day1).toMatch(/api {5}\| INFO Authorization: Bearer \[redacted\]/);
    expect(readFileSync(join(dir, 'app-20261018.log'), 'utf8')).toContain('web     | next day');
  });

  it('rolls a file over the size cap', () => {
    const dir = tmp();
    const log = createLog(dir, { maxBytes: 200, clock: () => new Date(2026, 9, 17) });
    for (let i = 0; i < 10; i++) log.write('api', `line ${i} ${'x'.repeat(40)}`);
    expect(readdirSync(dir).sort()).toEqual(['app-20261017.1.log', 'app-20261017.log']);
    const total = readdirSync(dir).reduce((n, f) => n + readFileSync(join(dir, f)).length, 0);
    expect(total).toBeLessThan(700);
  });

  it('keeps 7 days', () => {
    const dir = tmp();
    for (const d of ['20261009', '20261010', '20261011', '20261016', '20261017']) writeFileSync(join(dir, `app-${d}.log`), 'x');
    writeFileSync(join(dir, 'app-20261010.1.log'), 'x');
    writeFileSync(join(dir, 'other.txt'), 'x');
    prune(dir, new Date(2026, 9, 17), 7);
    expect(readdirSync(dir).sort()).toEqual(['app-20261011.log', 'app-20261016.log', 'app-20261017.log', 'other.txt']);
  });

  it('never throws when the folder cannot be written', () => {
    const file = join(tmp(), 'a-file');
    writeFileSync(file, 'x');
    const log = createLog(join(file, 'logs'));
    expect(() => log.write('api', 'hello')).not.toThrow();
  });
});
