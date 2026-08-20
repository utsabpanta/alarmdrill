import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@alarmdrill/core';
import { z } from 'zod';
import { agentError } from './errors.js';
import { diagnosisSchema } from './diagnostician.js';
import { gradeSchema } from './grader.js';

/**
 * Full run traces on disk, so a run can be re-graded later without re-running
 * the experiment — `replay` exists because prompts change and old grades were
 * produced under old prompts.
 *
 * Note what replay may and may not re-run: the GRADER only. A trace contains
 * both the evidence and the ground truth, so feeding one back to the
 * diagnostician would hand it the answer. There is deliberately no function
 * here that does that.
 */
export const traceSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  experimentId: z.string(),
  createdAt: z.string(),
  promptVersions: z.object({ diagnostician: z.string(), grader: z.string() }),
  modelName: z.string(),
  evidence: z.unknown(),
  diagnosis: diagnosisSchema,
  groundTruth: z.object({
    description: z.string(),
    expectedComponent: z.string(),
    expectedCategory: z.string(),
    expectedUndiagnosable: z.boolean().optional(),
  }),
  detection: z.object({
    detected: z.boolean(),
    timeToDetectMs: z.number().nullable(),
    novelAlertNames: z.array(z.string()),
    preexistingAlertNames: z.array(z.string()),
  }),
  grade: z.object({
    verdict: z.enum(['correct', 'partial', 'incorrect']),
    votes: z.array(gradeSchema),
    disagreementRate: z.number(),
    needsReview: z.boolean(),
    promptVersion: z.string(),
  }),
});

export type RunTrace = z.infer<typeof traceSchema>;

export interface TraceStore {
  readonly write: (trace: RunTrace) => Promise<void>;
  readonly read: (runId: string, experimentId: string) => Promise<RunTrace>;
  readonly list: (runId: string) => Promise<RunTrace[]>;
}

export interface TraceStoreDeps {
  readonly dir: string;
  readonly clock: Clock;
}

export function createTraceStore(deps: TraceStoreDeps): TraceStore {
  const runDir = (runId: string): string => join(deps.dir, runId);
  const filePath = (runId: string, experimentId: string): string =>
    join(runDir(runId), `${experimentId}.json`);

  const readTrace = async (path: string): Promise<RunTrace> => {
    const raw = await readFile(path, 'utf8');
    const parsed = traceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw agentError(`unreadable trace at ${path}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  };

  return {
    write: async (trace) => {
      await mkdir(runDir(trace.runId), { recursive: true });
      await writeFile(
        filePath(trace.runId, trace.experimentId),
        JSON.stringify(trace, null, 2),
        'utf8',
      );
    },

    read: (runId, experimentId) => readTrace(filePath(runId, experimentId)),

    list: async (runId) => {
      let names: string[];
      try {
        names = await readdir(runDir(runId));
      } catch (cause: unknown) {
        throw agentError(`no traces found for run ${runId}`, { cause });
      }
      const traces: RunTrace[] = [];
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        traces.push(await readTrace(join(runDir(runId), name)));
      }
      return traces.sort((a, b) => a.experimentId.localeCompare(b.experimentId));
    },
  };
}
