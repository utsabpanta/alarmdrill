import { z } from 'zod';
import type { Diagnosis } from './diagnostician.js';
import type { ModelClient } from './model.js';
import { loadPrompt } from './prompts.js';

/**
 * The grader is NOT blinded — it is the component that knows what we broke, and
 * comparing the diagnosis against ground truth is its whole job.
 *
 * Keeping it in the same package as the diagnostician is safe because the
 * diagnostician's signature cannot accept ground truth; the two never share an
 * input.
 */
export interface GroundTruth {
  /** Plain description of what was actually broken. */
  readonly description: string;
  readonly expectedComponent: string;
  readonly expectedCategory: Diagnosis['faultCategory'];
  /**
   * True when the fault genuinely produced no usable signal. "I cannot tell"
   * is then the correct answer, and confidently naming a component is not.
   */
  readonly expectedUndiagnosable?: boolean;
}

export const gradeSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  reasoning: z.string(),
});

export type Grade = z.infer<typeof gradeSchema>;
export type Verdict = Grade['verdict'];

export interface GradeResult {
  readonly verdict: Verdict;
  readonly votes: readonly Grade[];
  /** Fraction of votes that disagreed with the winning verdict. */
  readonly disagreementRate: number;
  /** True on a three-way split — no majority, so a human should look. */
  readonly needsReview: boolean;
  readonly promptVersion: string;
}

export interface GradeDeps {
  readonly model: ModelClient;
  readonly promptVersion?: string;
  /** Votes to take. Odd numbers only; 3 by default. */
  readonly votes?: number;
}

export const DEFAULT_VOTES = 3;

export async function gradeDiagnosis(
  diagnosis: Diagnosis,
  truth: GroundTruth,
  deps: GradeDeps,
): Promise<GradeResult> {
  const prompt = loadPrompt('grader', deps.promptVersion);
  const rounds = deps.votes ?? DEFAULT_VOTES;
  const user = renderGradingRequest(diagnosis, truth);

  const votes: Grade[] = [];
  for (let i = 0; i < rounds; i += 1) {
    votes.push(await deps.model.complete({ system: prompt.text, user, schema: gradeSchema }));
  }

  const tally = tallyVotes(votes);
  return { ...tally, votes, promptVersion: prompt.version };
}

export function tallyVotes(votes: readonly Grade[]): {
  verdict: Verdict;
  disagreementRate: number;
  needsReview: boolean;
} {
  if (votes.length === 0) {
    return { verdict: 'incorrect', disagreementRate: 0, needsReview: true };
  }

  const counts = new Map<Verdict, number>();
  for (const vote of votes) {
    counts.set(vote.verdict, (counts.get(vote.verdict) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort(([, a], [, b]) => b - a);
  const top = ranked[0];
  if (top === undefined) {
    return { verdict: 'incorrect', disagreementRate: 0, needsReview: true };
  }

  const [verdict, topCount] = top;
  const runnerUp = ranked[1]?.[1] ?? 0;
  // A tie means there is no mode. So does an even split, which is why votes
  // should be odd. Either way a human decides, not us.
  const noMajority = topCount === runnerUp || counts.size === votes.length;

  return {
    verdict,
    disagreementRate: (votes.length - topCount) / votes.length,
    needsReview: noMajority,
  };
}

export function renderGradingRequest(diagnosis: Diagnosis, truth: GroundTruth): string {
  return [
    '## Ground truth — what was actually broken',
    truth.description,
    `Component: ${truth.expectedComponent}`,
    `Failure kind: ${truth.expectedCategory}`,
    truth.expectedUndiagnosable === true
      ? 'NOTE: this fault produced no usable signal. "I cannot tell from this evidence" is the correct answer here.'
      : '',
    '',
    "## The engineer's diagnosis",
    `Component blamed: ${diagnosis.suspectedComponent}`,
    `Failure kind: ${diagnosis.faultCategory}`,
    `Confidence: ${diagnosis.confidence}`,
    `Reasoning: ${diagnosis.reasoning}`,
    `Evidence cited: ${diagnosis.evidenceCited.join('; ')}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
