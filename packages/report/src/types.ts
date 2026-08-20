import type { Diagnosis, GradeResult } from '@alarmdrill/agents';
import type { DetectionResult } from '@alarmdrill/observers';

/**
 * One experiment's outcome, as the report sees it. This is the only place
 * detection and diagnosis are put side by side — and keeping them separate
 * until here is the point: a fault can be detected and misdiagnosed, or
 * diagnosed correctly having never alerted at all.
 */
export interface ExperimentOutcome {
  readonly id: string;
  /** Human-readable name of what was broken. Safe here — the agent has finished. */
  readonly faultDescription: string;
  readonly target: string;
  readonly detection: DetectionResult;
  readonly diagnosis: Diagnosis;
  readonly grade: GradeResult;
  /** Set when the fault was expected to be undiagnosable from telemetry alone. */
  readonly expectedUndiagnosable?: boolean;
}

export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly outcomes: readonly ExperimentOutcome[];
  readonly promptVersions: Readonly<Record<string, string>>;
  readonly modelName: string;
}

export type GapKind = 'blind_spot' | 'needs_instrumentation' | 'late' | 'noisy' | 'covered';

export interface Finding {
  readonly experimentId: string;
  readonly kind: GapKind;
  readonly title: string;
  readonly explanation: string;
  /** A PromQL rule that would close the gap, when one could. */
  readonly proposedRule?: ProposedRule;
}

export interface ProposedRule {
  readonly alertName: string;
  readonly expr: string;
  readonly forDuration: string;
  readonly severity: string;
  readonly rationale: string;
}
