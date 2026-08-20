import { EventEmitter } from 'node:events';
import { createFakeClock, createSilentLogger } from '@alarmdrill/core';
import { describe, expect, it } from 'vitest';
import { createInjectionSession } from './session.js';
import { installSignalCleanup } from './signals.js';
import type { Injector, RevertPlan } from './types.js';

function buildSession(): {
  session: ReturnType<typeof createInjectionSession>;
  injector: Injector<{ target: string }> & { revertCount: () => number };
} {
  let reverts = 0;
  const injector = {
    kind: 'fake.fault',
    targetOf: (config: { target: string }) => config.target,
    revertCount: () => reverts,
    plan: (config: { target: string }) =>
      Promise.resolve({ kind: 'fake.fault', target: config.target, data: {} } satisfies RevertPlan),
    apply: () => Promise.resolve(),
    revert: () => {
      reverts += 1;
      return Promise.resolve();
    },
  };
  const open = new Map<string, never>();
  const session = createInjectionSession({
    journal: {
      record: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      listOpen: () => Promise.resolve([...open.values()]),
    },
    clock: createFakeClock(0),
    logger: createSilentLogger(),
    policy: { allow: ['lab-thing'] },
    registry: { 'fake.fault': injector },
  });
  return { session, injector };
}

describe('signal cleanup', () => {
  it('reverts everything and exits non-zero on SIGINT', async () => {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    const { session, injector } = buildSession();
    await session.inject(injector, { target: 'lab-thing' });

    installSignalCleanup({
      session,
      logger: createSilentLogger(),
      exit: (code) => exits.push(code),
      process: emitter,
    });

    emitter.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(injector.revertCount()).toBe(1);
    // Non-zero: an interrupted drill produced no verdict, and CI must not
    // mistake that for a pass.
    expect(exits).toEqual([130]);
  });

  it('ignores a second signal rather than racing itself', async () => {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    const { session, injector } = buildSession();
    await session.inject(injector, { target: 'lab-thing' });

    installSignalCleanup({
      session, logger: createSilentLogger(),
      exit: (code) => exits.push(code), process: emitter,
    });

    emitter.emit('SIGINT');
    emitter.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(injector.revertCount()).toBe(1);
    expect(exits).toEqual([130]);
  });

  it('detaches cleanly when uninstalled', () => {
    const emitter = new EventEmitter();
    const { session } = buildSession();
    const uninstall = installSignalCleanup({
      session, logger: createSilentLogger(), exit: () => undefined, process: emitter,
    });

    expect(emitter.listenerCount('SIGINT')).toBe(1);
    uninstall();
    expect(emitter.listenerCount('SIGINT')).toBe(0);
  });
});
