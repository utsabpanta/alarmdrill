import { z } from 'zod';
import { injectionError } from '../errors.js';
import { revertPlanSchema, type Injector, type RevertPlan } from '../types.js';

export const DECLINE_RATE_KIND = 'http.decline-rate';

export interface DeclineRateConfig {
  /** Control endpoint of the service whose behaviour we are changing. */
  readonly controlUrl: string;
  /** Label used for the allowlist — a URL is not a target name. */
  readonly target: string;
  readonly declineRate: number;
}

const declineResponseSchema = z.object({ declineRate: z.number().min(0).max(1) });
const declineDataSchema = z.object({
  controlUrl: z.string(),
  previousRate: z.number().min(0).max(1),
});

/**
 * Drives a dependency's business-outcome failure rate — the PSP that starts
 * declining while answering HTTP 200.
 *
 * Unlike the other injectors this one must READ before it can plan: revert
 * means restoring whatever rate was configured before, and that value only
 * exists in the running service. The read happens in `plan`, so the previous
 * rate is in the journal before anything changes.
 */
export function createDeclineRateInjector(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Injector<DeclineRateConfig> {
  const readRate = async (controlUrl: string): Promise<number> => {
    const response = await fetchImpl(controlUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw injectionError(
        `control endpoint ${controlUrl} responded ${String(response.status)} when reading the current rate`,
      );
    }
    const parsed = declineResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw injectionError(
        `control endpoint returned an unexpected shape: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data.declineRate;
  };

  const writeRate = async (controlUrl: string, declineRate: number): Promise<void> => {
    const response = await fetchImpl(controlUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ declineRate }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw injectionError(
        `control endpoint ${controlUrl} responded ${String(response.status)} when setting the rate`,
      );
    }
  };

  return {
    kind: DECLINE_RATE_KIND,
    targetOf: (config) => config.target,

    plan: async (config) => {
      const previousRate = await readRate(config.controlUrl);
      const plan: RevertPlan = {
        kind: DECLINE_RATE_KIND,
        target: config.target,
        data: { controlUrl: config.controlUrl, previousRate },
      };
      return revertPlanSchema.parse(plan);
    },

    apply: async (config) => {
      await writeRate(config.controlUrl, config.declineRate);
    },

    // Idempotent: writing the same previous rate twice is a no-op.
    revert: async (plan) => {
      const data = declineDataSchema.parse(plan.data);
      await writeRate(data.controlUrl, data.previousRate);
    },
  };
}
