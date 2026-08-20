import { randomUUID } from 'node:crypto';
import type { Clock, Logger } from '@alarmdrill/core';
import { injectionError, revertError } from './errors.js';
import { buildEntry, type Journal } from './journal.js';
import { assertTargetAllowed, type TargetPolicy } from './safety.js';
import type { Injector, JournalEntry, RevertPlan } from './types.js';

/** Deadman default. Nothing stays broken longer than this, whatever happens. */
export const DEFAULT_MAX_DURATION_MS = 120_000;

export interface ActiveInjection {
  readonly id: string;
  /** Idempotent. Safe to call from the happy path and an error handler both. */
  readonly revert: () => Promise<void>;
}

export interface SweepResult {
  readonly reverted: JournalEntry[];
  readonly failed: { entry: JournalEntry; reason: string }[];
}

export interface SessionDeps {
  readonly journal: Journal;
  readonly clock: Clock;
  readonly policy: TargetPolicy;
  readonly logger: Logger;
  /** Resolves a journalled `kind` back to the injector that can revert it. */
  readonly registry: Readonly<Record<string, Pick<Injector<never>, 'revert'>>>;
}

export interface InjectOptions {
  readonly maxDurationMs?: number;
}

export interface InjectionSession {
  readonly inject: <C>(
    injector: Injector<C>,
    config: C,
    options?: InjectOptions,
  ) => Promise<ActiveInjection>;
  /** Reverts whatever this session still has open. */
  readonly revertAll: () => Promise<void>;
  /** Reverts injections left behind by a previous process that died. */
  readonly sweepOrphans: () => Promise<SweepResult>;
  readonly activeCount: () => number;
}

export function createInjectionSession(deps: SessionDeps): InjectionSession {
  const active = new Map<string, ActiveInjection>();

  const revertPlan = async (plan: RevertPlan): Promise<void> => {
    const injector = deps.registry[plan.kind];
    if (injector === undefined) {
      throw revertError(
        `no injector registered for kind "${plan.kind}" — cannot revert, and something is still broken`,
      );
    }
    await injector.revert(plan);
  };

  const inject = async <C>(
    injector: Injector<C>,
    config: C,
    options: InjectOptions = {},
  ): Promise<ActiveInjection> => {
    // One fault at a time. Two concurrent faults make the diagnosis ambiguous
    // and the blast radius unbounded.
    if (active.size > 0) {
      throw injectionError(
        `an injection is already active (${[...active.keys()].join(', ')}); alarmdrill runs one fault at a time`,
      );
    }

    const target = injector.targetOf(config);
    assertTargetAllowed(target, deps.policy);

    const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    // plan() only reads. Nothing is broken yet, so a failure here is harmless.
    const plan = await injector.plan(config);
    const entry = buildEntry({ id: randomUUID(), plan, maxDurationMs, clock: deps.clock });

    // THE ordering guarantee: on disk before it is real.
    await deps.journal.record(entry);

    let reverted = false;
    // Boxed: revert() closes over this and may run before the timer is armed.
    const deadman: { cancel?: () => void } = {};

    const revert = async (): Promise<void> => {
      if (reverted) return; // idempotent — it will be called twice
      reverted = true;
      deadman.cancel?.();
      active.delete(entry.id);
      try {
        await revertPlan(plan);
      } catch (cause: unknown) {
        throw revertError(`failed to revert ${plan.kind} on ${plan.target}`, { cause });
      } finally {
        // Drop the journal entry even if revert threw: a stuck entry would make
        // the next run's sweep retry forever against a target we cannot fix.
        // The thrown ERR_REVERT is what escalates this to a human.
        await deps.journal.complete(entry.id);
      }
    };

    try {
      await injector.apply(config);
    } catch (cause: unknown) {
      await revert().catch(() => undefined);
      throw injectionError(`failed to apply ${plan.kind} to ${plan.target}`, { cause });
    }

    deadman.cancel = deps.clock.setTimer(maxDurationMs, () => {
      deps.logger.warn(
        { id: entry.id, kind: plan.kind, target: plan.target, maxDurationMs },
        'deadman timer expired, reverting unconditionally',
      );
      void revert().catch((error: unknown) => {
        deps.logger.error({ err: error }, 'deadman revert failed');
      });
    });

    const handle: ActiveInjection = { id: entry.id, revert };
    active.set(entry.id, handle);
    return handle;
  };

  return {
    inject,
    activeCount: () => active.size,

    revertAll: async () => {
      const errors: unknown[] = [];
      for (const handle of [...active.values()]) {
        await handle.revert().catch((error: unknown) => errors.push(error));
      }
      if (errors.length > 0) {
        throw revertError(`${String(errors.length)} injection(s) failed to revert`, {
          cause: errors[0],
        });
      }
    },

    sweepOrphans: async () => {
      const open = await deps.journal.listOpen();
      const reverted: JournalEntry[] = [];
      const failed: { entry: JournalEntry; reason: string }[] = [];

      for (const entry of open) {
        try {
          await revertPlan(entry.plan);
          await deps.journal.complete(entry.id);
          reverted.push(entry);
          deps.logger.info(
            { id: entry.id, kind: entry.kind, target: entry.target },
            'reverted orphaned injection from a previous run',
          );
        } catch (error: unknown) {
          failed.push({
            entry,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { reverted, failed };
    },
  };
}
