import { z } from 'zod';
import { revertPlanSchema, type Injector, type RevertPlan } from '../types.js';
import type { ToxiproxyClient } from '../toxiproxy.js';

export const LATENCY_KIND = 'toxiproxy.latency';

export interface LatencyConfig {
  /** Toxiproxy proxy name, e.g. 'checkout-to-payments'. */
  readonly proxy: string;
  readonly latencyMs: number;
  readonly jitterMs?: number;
}

/** Journalled shape. Validated on the way back in, after a crash. */
const latencyDataSchema = z.object({ proxy: z.string(), toxicName: z.string() });

/** Namespaced so a sweep can tell our toxics from someone else's. */
const toxicNameFor = (proxy: string): string => `alarmdrill-latency-${proxy}`;

export function createLatencyInjector(client: ToxiproxyClient): Injector<LatencyConfig> {
  return {
    kind: LATENCY_KIND,
    targetOf: (config) => config.proxy,

    plan: (config) => {
      // Nothing to read: the toxic name is ours to choose, so revert is fully
      // determined before anything is touched.
      const plan: RevertPlan = {
        kind: LATENCY_KIND,
        target: config.proxy,
        data: { proxy: config.proxy, toxicName: toxicNameFor(config.proxy) },
      };
      return Promise.resolve(revertPlanSchema.parse(plan));
    },

    apply: async (config) => {
      await client.addToxic(config.proxy, {
        name: toxicNameFor(config.proxy),
        type: 'latency',
        stream: 'downstream',
        toxicity: 1,
        attributes: { latency: config.latencyMs, jitter: config.jitterMs ?? 0 },
      });
    },

    revert: async (plan) => {
      const data = latencyDataSchema.parse(plan.data);
      await client.removeToxic(data.proxy, data.toxicName);
    },
  };
}
