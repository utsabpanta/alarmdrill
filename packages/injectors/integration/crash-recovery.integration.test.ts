import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSilentLogger, systemClock } from '@alarmdrill/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFileJournal,
  createInjectionSession,
  createLatencyInjector,
  createToxiproxyClient,
} from '../src/index.js';

/**
 * The guarantee this package exists to provide: if alarmdrill is SIGKILLed with
 * a fault applied, the next run finds it and puts it back.
 *
 * SIGKILL specifically — no handler runs, no finally block executes, nothing
 * in memory survives. Only the journal on disk does.
 *
 * Runs against the lab's Toxiproxy: `pnpm lab:up` first, then
 * `pnpm test:integration`.
 */
const BASE_URL = process.env['TOXIPROXY_URL'] ?? 'http://localhost:8474';
const PROXY = 'alarmdrill-crash-test';
const CHILD = fileURLToPath(new URL('./orphan-child.ts', import.meta.url));
const PKG_DIR = fileURLToPath(new URL('../', import.meta.url));

let reachable = false;

beforeAll(async () => {
  try {
    const response = await fetch(`${BASE_URL}/proxies`, { signal: AbortSignal.timeout(2_000) });
    reachable = response.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) return;

  // Scratch proxy of our own, so the test never disturbs the lab's wiring.
  await fetch(`${BASE_URL}/proxies/${PROXY}`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${BASE_URL}/proxies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: PROXY,
      listen: '0.0.0.0:19100',
      upstream: 'payments:3002',
      enabled: true,
    }),
  });
});

const toxicNames = async (): Promise<string[]> => {
  const proxy = (await (await fetch(`${BASE_URL}/proxies/${PROXY}`)).json()) as {
    toxics: { name: string }[];
  };
  return proxy.toxics.map((t) => t.name);
};

describe('crash recovery against a real toxiproxy', () => {
  it('sweeps a fault left behind by a SIGKILLed process', async () => {
    if (!reachable) {
      // Loud skip: a silent pass here would be the worst possible outcome,
      // since this is the test that proves cleanup survives a crash.
      throw new Error(
        `toxiproxy not reachable at ${BASE_URL}. Run 'pnpm lab:up' before 'pnpm test:integration'.`,
      );
    }

    const journalDir = await mkdtemp(join(tmpdir(), 'alarmdrill-crash-'));

    // 1. A child journals and applies a fault, then hangs.
    const child = spawn('pnpm', ['exec', 'tsx', CHILD, journalDir, BASE_URL, PROXY], {
      cwd: PKG_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Resolve workspace packages from source, matching how vitest runs.
      // Without this the child would import a stale dist build.
      env: { ...process.env, NODE_OPTIONS: '--conditions=development' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    // AbortSignal.timeout rather than setTimeout: this package forbids raw
    // timers, and there is no reason for a test harness to be the exception.
    const deadline = AbortSignal.timeout(60_000);
    await new Promise<void>((resolve, reject) => {
      deadline.addEventListener('abort', () => {
        reject(new Error(`child never reported INJECTED. stderr:\n${stderr}`));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('INJECTED')) resolve();
      });
      child.on('exit', (code) => {
        reject(new Error(`child exited early with ${String(code)}. stderr:\n${stderr}`));
      });
    });

    expect(await toxicNames()).toContain(`alarmdrill-latency-${PROXY}`);

    // 2. Kill it dead. No handler, no finally, no graceful anything.
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // The fault is still applied and nothing in memory remembers it.
    expect(await toxicNames()).toContain(`alarmdrill-latency-${PROXY}`);

    // 3. A fresh session sweeps, using only what is on disk.
    const injector = createLatencyInjector(createToxiproxyClient({ baseUrl: BASE_URL }));
    const session = createInjectionSession({
      journal: createFileJournal({ dir: journalDir, clock: systemClock }),
      clock: systemClock,
      logger: createSilentLogger(),
      policy: { allow: [PROXY] },
      registry: { [injector.kind]: injector },
    });

    const result = await session.sweepOrphans();

    expect(result.failed).toEqual([]);
    expect(result.reverted).toHaveLength(1);
    expect(result.reverted[0]?.target).toBe(PROXY);
    expect(await toxicNames()).toEqual([]);

    // 4. Sweeping again finds nothing — the journal entry is gone too.
    expect((await session.sweepOrphans()).reverted).toEqual([]);
  }, 180_000);
});
