import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module without types
import { choosePorts, clearState, findRunning, isFree, ourApi, upToDate, writeState } from '../launcher.mjs';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** An HTTP server on a free port answering /api/health with `body`. */
async function serve(body: unknown): Promise<number> {
  const s = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

describe('launcher', () => {
  it('tells this app apart from another program on the port', async () => {
    const ours = await serve({ status: 'ok', app: 'open-golf-tracer', version: '1.2.3' });
    const other = await serve({ status: 'ok' });
    expect((await ourApi(ours))?.version).toBe('1.2.3');
    expect(await ourApi(other)).toBeNull();
    expect(await isFree(other)).toBe(false);
  });

  it('moves a default port that another program holds, but keeps one that was asked for', async () => {
    const taken = await serve({});
    const free = await choosePorts({ api: taken, web: taken + 1 });
    expect(free.api).not.toBe(taken);
    expect(free.web).not.toBe(free.api);
    expect(free.moved).toEqual(expect.arrayContaining([expect.objectContaining({ what: 'api', from: taken, to: free.api })]));
    expect(await isFree(free.api)).toBe(true);
    const fixed = await choosePorts({ api: taken, web: free.web, apiFixed: true });
    expect(fixed.api).toBe(taken);
  });

  it('finds the running copy through ports.json, and ignores one that is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogt-launcher-'));
    const api = await serve({ status: 'ok', app: 'open-golf-tracer', version: '0.4.0' });
    writeState(dir, { web: 3999, api, pid: 4242 });
    expect(readFileSync(join(dir, 'app.pid'), 'utf8')).toBe('4242');
    expect(await findRunning(dir, { api: 1, web: 2 })).toEqual({ web: 3999, api, version: '0.4.0' });
    await new Promise((r) => servers.pop()!.close(r));
    expect(await findRunning(dir, { api: 1, web: 2 })).toBeNull();
    clearState(dir, 1); // another launcher's files stay
    expect(existsSync(join(dir, 'ports.json'))).toBe(true);
    clearState(dir, 4242);
    expect(existsSync(join(dir, 'ports.json')) || existsSync(join(dir, 'app.pid'))).toBe(false);
  });

  it('uses a bundle only while it is newer than its sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogt-bundle-'));
    mkdirSync(join(dir, 'src/deep'), { recursive: true });
    writeFileSync(join(dir, 'src/deep/a.ts'), '');
    const bundle = join(dir, 'main.mjs');
    expect(upToDate(bundle, [join(dir, 'src')])).toBe(false);
    writeFileSync(bundle, '');
    utimesSync(join(dir, 'src/deep/a.ts'), new Date(1000), new Date(1000));
    expect(upToDate(bundle, [join(dir, 'src')])).toBe(true);
    utimesSync(join(dir, 'src/deep/a.ts'), new Date(), new Date(Date.now() + 60_000));
    expect(upToDate(bundle, [join(dir, 'src')])).toBe(false);
  });
});
