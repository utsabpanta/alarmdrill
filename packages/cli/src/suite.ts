import { readFileSync } from 'node:fs';
import { validationError } from '@alarmdrill/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * A suite says what to break, where, and what the right answer is.
 *
 * Ground truth lives here, in the file the operator writes, rather than being
 * inferred from the fault. Inferring it would mean the tool grading itself
 * against its own assumptions; making someone write down "this should look like
 * a dependency outage on redis" is the whole basis for the score being worth
 * anything.
 *
 * Config is an external boundary, so it is parsed, not trusted.
 */
const faultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('docker.stop'),
    container: z.string().min(1),
  }),
  z.object({
    kind: z.literal('toxiproxy.latency'),
    proxy: z.string().min(1),
    latencyMs: z.number().int().positive(),
    jitterMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('http.decline-rate'),
    controlUrl: z.url(),
    target: z.string().min(1),
    declineRate: z.number().min(0).max(1),
  }),
]);

export type FaultSpec = z.infer<typeof faultSchema>;

const groundTruthSchema = z.object({
  /** What a competent responder should name. */
  component: z.string().min(1),
  category: z.enum([
    'dependency_unavailable',
    'latency',
    'resource_exhaustion',
    'business_logic_failure',
    'configuration',
    'unknown',
  ]),
  /**
   * Set when the fault genuinely produces no usable signal. "I cannot tell from
   * this evidence" then becomes the correct answer, and a confident guess is
   * the wrong one.
   */
  undiagnosable: z.boolean().default(false),
});

const experimentSchema = z.object({
  id: z.string().min(1),
  /** Plain-language description, shown only after grading. */
  description: z.string().min(1),
  fault: faultSchema,
  groundTruth: groundTruthSchema,
  holdMs: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
});

export type SuiteExperimentSpec = z.infer<typeof experimentSchema>;

export const suiteSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    endpoints: z.object({
      toxiproxy: z.url().default('http://localhost:8474'),
      alertmanager: z.url().default('http://localhost:9093'),
      prometheus: z.url().default('http://localhost:9090'),
    }),
    safety: z.object({
      /** Exact target names that may be broken. No wildcards, on purpose. */
      allow: z.array(z.string().min(1)).min(1),
    }),
    defaults: z
      .object({
        holdMs: z.number().int().positive().default(90_000),
        maxDurationMs: z.number().int().positive().default(120_000),
        windowPaddingMs: z.number().int().positive().default(120_000),
        pollIntervalMs: z.number().int().positive().default(2_000),
      })
      .prefault({}),
    experiments: z.array(experimentSchema).min(1),
  })
  .superRefine((suite, ctx) => {
    const ids = suite.experiments.map((e) => e.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate experiment id "${duplicate}" — ids name trace files and must be unique`,
      });
    }

    // Fail at load time rather than mid-run: discovering an unlisted target
    // after three faults have already been applied is a bad time to find out.
    for (const experiment of suite.experiments) {
      const target = targetOf(experiment.fault);
      if (!suite.safety.allow.includes(target)) {
        ctx.addIssue({
          code: 'custom',
          message: `experiment "${experiment.id}" targets "${target}", which is not in safety.allow`,
        });
      }
    }
  });

export type Suite = z.infer<typeof suiteSchema>;

export function targetOf(fault: FaultSpec): string {
  switch (fault.kind) {
    case 'docker.stop':
      return fault.container;
    case 'toxiproxy.latency':
      return fault.proxy;
    case 'http.decline-rate':
      return fault.target;
  }
}

export function loadSuite(path: string): Suite {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause: unknown) {
    throw validationError(`cannot read suite file ${path}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (cause: unknown) {
    throw validationError(`suite file ${path} is not valid YAML or JSON`, { cause });
  }

  const result = suiteSchema.safeParse(parsed);
  if (!result.success) {
    throw validationError(`invalid suite ${path}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
