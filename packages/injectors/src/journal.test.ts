import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock } from '@alarmdrill/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildEntry, createFileJournal, type Journal } from './journal.js';
import type { RevertPlan } from './types.js';

const plan: RevertPlan = {
  kind: 'toxiproxy.latency',
  target: 'checkout-to-payments',
  data: { proxy: 'checkout-to-payments', toxicName: 'alarmdrill-latency-checkout-to-payments' },
};

describe('file journal', () => {
  let dir: string;
  let journal: Journal;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alarmdrill-journal-'));
    journal = createFileJournal({ dir, clock: createFakeClock(0) });
  });

  it('round-trips an entry through the filesystem', async () => {
    const clock = createFakeClock(new Date('2026-03-01T12:00:00.000Z'));
    const entry = buildEntry({ id: 'abc', plan, maxDurationMs: 120_000, clock });
    await journal.record(entry);

    const open = await journal.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: 'abc',
      kind: 'toxiproxy.latency',
      journaledAt: '2026-03-01T12:00:00.000Z',
    });
  });

  it('leaves no entry behind once completed', async () => {
    const entry = buildEntry({ id: 'abc', plan, maxDurationMs: 1_000, clock: createFakeClock(0) });
    await journal.record(entry);
    await journal.complete('abc');

    expect(await journal.listOpen()).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('completing twice is not an error', async () => {
    await journal.complete('never-existed');
    await expect(journal.complete('never-existed')).resolves.toBeUndefined();
  });

  it('reports no open entries when the directory does not exist yet', async () => {
    const fresh = createFileJournal({ dir: join(dir, 'nope'), clock: createFakeClock(0) });
    expect(await fresh.listOpen()).toEqual([]);
  });

  // A journal we cannot read means something may still be broken out there.
  // Skipping the entry would silently strand it.
  it('refuses to skip an entry it cannot parse', async () => {
    await writeFile(join(dir, 'corrupt.json'), '{"id":"x","kind":42}', 'utf8');
    await expect(journal.listOpen()).rejects.toThrow(/unreadable journal entry/);
  });

  it('returns entries oldest first, so a sweep unwinds in order', async () => {
    const early = buildEntry({
      id: 'early', plan, maxDurationMs: 1_000,
      clock: createFakeClock(new Date('2026-01-01T00:00:00.000Z')),
    });
    const late = buildEntry({
      id: 'late', plan, maxDurationMs: 1_000,
      clock: createFakeClock(new Date('2026-06-01T00:00:00.000Z')),
    });
    await journal.record(late);
    await journal.record(early);

    expect((await journal.listOpen()).map((e) => e.id)).toEqual(['early', 'late']);
  });
});
