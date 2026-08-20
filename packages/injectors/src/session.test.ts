import { createFakeClock, createSilentLogger, hasErrorCode, type Clock } from '@alarmdrill/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Journal } from './journal.js';
import { createInjectionSession, type InjectionSession } from './session.js';
import type { Injector, JournalEntry, RevertPlan } from './types.js';

/** Records every lifecycle call so ordering can be asserted, not assumed. */
function createTrace(): { calls: string[] } {
  return { calls: [] };
}

function createFakeJournal(trace: { calls: string[] }): Journal & { open: Map<string, JournalEntry> } {
  const open = new Map<string, JournalEntry>();
  return {
    open,
    record: (entry) => {
      trace.calls.push('journal.record');
      open.set(entry.id, entry);
      return Promise.resolve();
    },
    complete: (id) => {
      trace.calls.push('journal.complete');
      open.delete(id);
      return Promise.resolve();
    },
    listOpen: () => Promise.resolve([...open.values()]),
  };
}

interface FakeConfig {
  readonly target: string;
}

function createFakeInjector(
  trace: { calls: string[] },
  behaviour: { failApply?: boolean; failRevert?: boolean } = {},
): Injector<FakeConfig> & { revertCount: () => number } {
  let reverts = 0;
  return {
    kind: 'fake.fault',
    targetOf: (config) => config.target,
    revertCount: () => reverts,
    plan: (config) => {
      trace.calls.push('injector.plan');
      return Promise.resolve({
        kind: 'fake.fault',
        target: config.target,
        data: { target: config.target },
      } satisfies RevertPlan);
    },
    apply: () => {
      trace.calls.push('injector.apply');
      return behaviour.failApply === true
        ? Promise.reject(new Error('apply blew up'))
        : Promise.resolve();
    },
    revert: () => {
      trace.calls.push('injector.revert');
      reverts += 1;
      return behaviour.failRevert === true
        ? Promise.reject(new Error('revert blew up'))
        : Promise.resolve();
    },
  };
}

function buildSession(
  trace: { calls: string[] },
  injector: Injector<FakeConfig>,
  clock: Clock,
): { session: InjectionSession; journal: ReturnType<typeof createFakeJournal> } {
  const journal = createFakeJournal(trace);
  const session = createInjectionSession({
    journal,
    clock,
    logger: createSilentLogger(),
    policy: { allow: ['lab-thing'] },
    registry: { 'fake.fault': injector },
  });
  return { session, journal };
}

describe('injection session', () => {
  let trace: { calls: string[] };

  beforeEach(() => {
    trace = createTrace();
  });

  it('journals before it injects, never after', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace);
    const { session } = buildSession(trace, injector, clock);

    await session.inject(injector, { target: 'lab-thing' });

    // The whole crash-recovery story depends on this exact order.
    expect(trace.calls).toEqual(['injector.plan', 'journal.record', 'injector.apply']);
    expect(trace.calls.indexOf('journal.record')).toBeLessThan(
      trace.calls.indexOf('injector.apply'),
    );
  });

  it('reverts exactly once even when revert is called twice', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace);
    const { session, journal } = buildSession(trace, injector, clock);

    const active = await session.inject(injector, { target: 'lab-thing' });
    await active.revert();
    await active.revert(); // it WILL be called twice

    expect(injector.revertCount()).toBe(1);
    expect(journal.open.size).toBe(0);
  });

  it('reverts and clears the journal when apply fails', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace, { failApply: true });
    const { session, journal } = buildSession(trace, injector, clock);

    await expect(session.inject(injector, { target: 'lab-thing' })).rejects.toThrow(/failed to apply/);
    expect(injector.revertCount()).toBe(1);
    expect(journal.open.size).toBe(0);
    expect(session.activeCount()).toBe(0);
  });

  it('deadman timer reverts unconditionally once maxDuration elapses', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace);
    const { session, journal } = buildSession(trace, injector, clock);

    await session.inject(injector, { target: 'lab-thing' }, { maxDurationMs: 120_000 });
    expect(injector.revertCount()).toBe(0);

    await clock.advance(119_999);
    expect(injector.revertCount()).toBe(0);

    await clock.advance(1);
    expect(injector.revertCount()).toBe(1);
    expect(journal.open.size).toBe(0);
  });

  it('cancels the deadman once reverted, so it cannot fire against a healthy target', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace);
    const { session } = buildSession(trace, injector, clock);

    const active = await session.inject(injector, { target: 'lab-thing' });
    await active.revert();
    await clock.advance(600_000);

    expect(injector.revertCount()).toBe(1);
  });

  it('runs one fault at a time', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace);
    const { session } = buildSession(trace, injector, clock);

    await session.inject(injector, { target: 'lab-thing' });
    await expect(session.inject(injector, { target: 'lab-thing' })).rejects.toThrow(
      /one fault at a time/,
    );
  });

  it('refuses a target outside the allowlist before journalling anything', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace);
    const { session, journal } = buildSession(trace, injector, clock);

    await expect(session.inject(injector, { target: 'prod-payments' })).rejects.toThrow();
    expect(trace.calls).toEqual([]); // nothing planned, nothing journalled
    expect(journal.open.size).toBe(0);
  });

  it('raises ERR_REVERT when revert fails, and still clears the entry', async () => {
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace, { failRevert: true });
    const { session, journal } = buildSession(trace, injector, clock);

    const active = await session.inject(injector, { target: 'lab-thing' });
    try {
      await active.revert();
      expect.unreachable('revert should have thrown');
    } catch (error: unknown) {
      expect(hasErrorCode(error, 'ERR_REVERT')).toBe(true);
    }
    expect(journal.open.size).toBe(0);
  });
});

describe('crash recovery', () => {
  it('sweeps injections a dead process left behind', async () => {
    const trace = createTrace();
    const clock = createFakeClock(0);
    const injector = createFakeInjector(trace);
    const journal = createFakeJournal(trace);

    // Simulate the previous process: journalled, applied, then SIGKILLed.
    journal.open.set('orphan-1', {
      id: 'orphan-1',
      kind: 'fake.fault',
      target: 'lab-thing',
      journaledAt: '2026-01-01T00:00:00.000Z',
      maxDurationMs: 120_000,
      plan: { kind: 'fake.fault', target: 'lab-thing', data: { target: 'lab-thing' } },
    });

    const session = createInjectionSession({
      journal,
      clock,
      logger: createSilentLogger(),
      policy: { allow: ['lab-thing'] },
      registry: { 'fake.fault': injector },
    });

    const result = await session.sweepOrphans();

    expect(result.reverted.map((e) => e.id)).toEqual(['orphan-1']);
    expect(result.failed).toEqual([]);
    expect(injector.revertCount()).toBe(1);
    expect(journal.open.size).toBe(0);
  });

  it('reports an orphan it cannot revert instead of pretending it succeeded', async () => {
    const trace = createTrace();
    const journal = createFakeJournal(trace);
    journal.open.set('orphan-2', {
      id: 'orphan-2',
      kind: 'kind.that.no.longer.exists',
      target: 'lab-thing',
      journaledAt: '2026-01-01T00:00:00.000Z',
      maxDurationMs: 120_000,
      plan: { kind: 'kind.that.no.longer.exists', target: 'lab-thing', data: {} },
    });

    const session = createInjectionSession({
      journal,
      clock: createFakeClock(0),
      logger: createSilentLogger(),
      policy: { allow: ['lab-thing'] },
      registry: {},
    });

    const result = await session.sweepOrphans();
    expect(result.reverted).toEqual([]);
    expect(result.failed[0]?.reason).toMatch(/no injector registered/);
    expect(journal.open.size).toBe(1); // still open, still needs a human
  });
});
