import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.ts';
import { hashToken } from '../src/auth.ts';
import { type World, call, createWorld } from './helpers.ts';

const DEPLOY_TOKEN = 'release-token-from-the-workflow';
const download = (version: string) =>
  `https://github.com/amlcx/mpf-pos/releases/download/v${version}/Mi.Postre.Favorito_${version}_x64-setup.exe`;
/** What scripts/offer-release.mjs sends. */
const offer = (version: string, ring: 'pilot' | 'stable', extra: object = {}) => ({
  version,
  ring,
  notes: `Notas de ${version}`,
  pubDate: '2026-10-17T15:00:00.000Z',
  url: download(version),
  signature: `sig-${version}`,
  ...extra,
});

let w: World;
let app: App;
const tokenA = () => w.terminals.A.token;
const tokenB = () => w.terminals.B.token;
const releases = (path: string, body: unknown, token: string | null = DEPLOY_TOKEN) =>
  call(app, token, 'POST', `/releases${path}`, body);
const check = (token: string, current: string, target = 'windows', arch = 'x86_64') =>
  call(app, token, 'GET', `/updates/${target}/${arch}/${current}`);

beforeAll(async () => {
  w = await createWorld('releases');
  app = createApp({ sql: w.sql, sessionSecret: 'test-secret-test-secret', releaseTokenSha256: hashToken(DEPLOY_TOKEN) });
  // A is a pilot register; B stays on the default, stable.
  await w.sql`update terminals set release_ring = 'pilot' where id = ${w.terminals.A.id}`;
});
afterAll(() => w.close());

describe('releases', () => {
  it('answers 204 while no release has been offered', async () => {
    const res = await check(tokenA(), '0.1.0');
    expect(res.status).toBe(204);
    expect((await check('mpf_nope', '0.1.0')).status).toBe(401);
  });

  it('refuses anyone without the deploy token', async () => {
    expect((await releases('', offer('1.1.0', 'pilot'), null)).status).toBe(401);
    expect((await releases('', offer('1.1.0', 'pilot'), 'wrong-token')).status).toBe(401);
    expect((await releases('', offer('1.1.0', 'pilot'), tokenA())).status).toBe(401);
    expect((await releases('/promote', { version: '1.1.0', from: 'pilot', to: 'stable' }, 'wrong')).status).toBe(401);
    // A server with no hash configured accepts no token at all.
    const unconfigured = createApp({ sql: w.sql, sessionSecret: 'test-secret-test-secret' });
    expect((await call(unconfigured, DEPLOY_TOKEN, 'POST', '/releases', offer('1.1.0', 'pilot'))).status).toBe(401);
    expect((await w.sql`select * from register_releases`).length).toBe(0);
  });

  it('accepts only installers published on this repository under the same tag', async () => {
    const bad = [
      'https://github.com/someone/else/releases/download/v1.1.0/x.exe',
      'https://evil.example/amlcx/mpf-pos/releases/download/v1.1.0/x.exe',
      'http://github.com/amlcx/mpf-pos/releases/download/v1.1.0/x.exe',
      'https://github.com/amlcx/mpf-pos/releases/download/v1.1.0/../../../../someone/else/x.exe',
      'https://github.com/amlcx/mpf-pos/releases/download/v1.1.0/%2e%2e/%2e%2e/x.exe',
      download('1.0.0'), // another version's file
    ];
    for (const url of bad) {
      expect((await releases('', offer('1.1.0', 'pilot', { url }))).status, url).toBe(400);
    }
    expect((await releases('', offer('1.1', 'pilot'))).status).toBe(400);
    expect((await releases('', offer('1.1.0', 'pilot', { ring: 'beta' }))).status).toBe(400);
    expect((await w.sql`select * from register_releases`).length).toBe(0);
  });

  it('offers each ring its own release, and only when it is newer', async () => {
    expect((await releases('', offer('1.1.0', 'stable'))).status).toBe(200);
    expect((await releases('', offer('1.2.0', 'pilot'))).status).toBe(200);

    const pilot = await check(tokenA(), '1.1.0');
    expect(pilot.status).toBe(200);
    expect(pilot.json).toEqual({
      version: '1.2.0',
      notes: 'Notas de 1.2.0',
      pub_date: '2026-10-17T15:00:00.000Z',
      url: download('1.2.0'),
      signature: 'sig-1.2.0',
    });
    expect((await check(tokenB(), '1.0.0')).json.version).toBe('1.1.0');

    // Already there, or ahead (versions compare as numbers, not text).
    expect((await check(tokenA(), '1.2.0')).status).toBe(204);
    expect((await check(tokenB(), '1.1.0')).status).toBe(204);
    expect((await check(tokenB(), '1.10.0')).status).toBe(204);
    expect((await check(tokenB(), '1.9.9')).status).toBe(204);
    // Only Windows installers are published.
    expect((await check(tokenA(), '1.1.0', 'linux')).status).toBe(204);
    expect((await check(tokenA(), '1.1.0', 'windows', 'aarch64')).status).toBe(204);
    expect((await check(tokenA(), 'latest')).status).toBe(400);
  });

  it('records the version each register reports, writing only when it changes', async () => {
    // The update check writes nothing else, unlike /sync/pull (last_seen_at).
    const pull = (version?: string) =>
      app.request('/updates/windows/x86_64/0.1.0', {
        headers: { Authorization: `Bearer ${tokenB()}`, ...(version ? { 'X-App-Version': version } : {}) },
      });
    const recorded = async () =>
      (await w.sql<{ appVersion: string | null }[]>`select app_version from terminals where id = ${w.terminals.B.id}`)[0]!
        .appVersion;

    expect(await recorded()).toBeNull();
    expect((await pull('1.1.0')).ok).toBe(true);
    expect(await recorded()).toBe('1.1.0');
    // Missing or malformed headers leave it alone.
    await pull();
    await pull('not-a-version');
    expect(await recorded()).toBe('1.1.0');

    // Same version again: no write. A changed one: one write.
    const [before] = await w.sql<{ xmin: string }[]>`select xmin::text from terminals where id = ${w.terminals.B.id}`;
    await pull('1.1.0');
    const [same] = await w.sql<{ xmin: string }[]>`select xmin::text from terminals where id = ${w.terminals.B.id}`;
    expect(same!.xmin).toBe(before!.xmin);
    await pull('1.2.0');
    expect(await recorded()).toBe('1.2.0');
  });

  it('promotes to stable only the version the pilot ring runs', async () => {
    const promote = (version: string, extra: object = {}) =>
      releases('/promote', { version, from: 'pilot', to: 'stable', ...extra });

    const wrong = await promote('1.1.0');
    expect(wrong.status).toBe(409);
    expect(wrong.json).toMatchObject({ error: 'pilot_not_on_version', pilot: '1.2.0' });
    expect((await promote('1.2.0', { from: 'stable', to: 'pilot' })).status).toBe(400);
    expect((await check(tokenB(), '1.1.0')).status).toBe(204);

    expect((await promote('1.2.0')).status).toBe(200);
    const stable = await check(tokenB(), '1.1.0');
    expect(stable.json).toEqual((await check(tokenA(), '1.1.0')).json);
    expect(stable.json.version).toBe('1.2.0');
  });

  it('speaks the same shapes as scripts/offer-release.mjs', async () => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const dir = await mkdtemp(join(tmpdir(), 'mpf-release-'));
      const manifest = join(dir, 'latest.json');
      // The latest.json tauri-action uploads to a release.
      await writeFile(
        manifest,
        JSON.stringify({
          version: '1.3.0',
          notes: 'Arreglos',
          pub_date: '2026-10-18T12:00:00.000Z',
          platforms: { 'windows-x86_64': { signature: 'sig-1.3.0', url: download('1.3.0') } },
        }),
      );
      const script = fileURLToPath(new URL('../../../scripts/offer-release.mjs', import.meta.url));
      const env = { ...process.env, API_BASE_URL: `http://127.0.0.1:${port}`, RELEASE_DEPLOY_TOKEN: DEPLOY_TOKEN };
      const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, ...args], { env });

      await run('offer', '--version', '1.3.0', '--ring', 'pilot', '--manifest', manifest);
      expect((await check(tokenA(), '1.2.0')).json).toMatchObject({ version: '1.3.0', notes: 'Arreglos' });
      await run('promote', '--version', '1.3.0');
      expect((await check(tokenB(), '1.2.0')).json).toMatchObject({ version: '1.3.0', signature: 'sig-1.3.0' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
