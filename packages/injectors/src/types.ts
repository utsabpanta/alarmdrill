import { z } from 'zod';

/**
 * A revert plan is everything needed to undo an injection — and it must survive
 * the process dying. After a crash the journal file on disk is all we have, so
 * a plan carries no closures, no handles, nothing but JSON.
 */
export const revertPlanSchema = z.object({
  kind: z.string().min(1),
  target: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

export type RevertPlan = z.infer<typeof revertPlanSchema>;

/**
 * Injectors are three functions, deliberately split so the journal can be
 * written between the second and third.
 *
 * `plan` reads whatever revert will need later (the previous value of a
 * setting, say) and must not change anything. `apply` breaks something.
 * `revert` puts it back and MUST be idempotent — it is called by the happy
 * path, the error path, the deadman timer and crash recovery, and more than
 * one of those routinely fires for the same injection.
 */
export interface Injector<Config> {
  readonly kind: string;
  /** Names the thing being broken, for the safety allowlist. */
  readonly targetOf: (config: Config) => string;
  readonly plan: (config: Config) => Promise<RevertPlan>;
  readonly apply: (config: Config) => Promise<void>;
  readonly revert: (plan: RevertPlan) => Promise<void>;
}

export const journalEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  target: z.string().min(1),
  /** ISO 8601. Written before the fault is applied, so it may slightly precede it. */
  journaledAt: z.string(),
  maxDurationMs: z.number().int().positive(),
  plan: revertPlanSchema,
});

export type JournalEntry = z.infer<typeof journalEntrySchema>;
