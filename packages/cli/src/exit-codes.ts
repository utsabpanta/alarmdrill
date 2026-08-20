import { isAlarmdrillError } from '@alarmdrill/core';

/**
 * The one place in the codebase where typed errors become numbers. Packages
 * throw; only the CLI boundary decides what the shell sees.
 */
export const EXIT_CODES = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  run: 3,
  injection: 4,
  /** Loudest failure we have: something is still broken in the target. */
  revert: 5,
  observation: 6,
  agent: 7,
  report: 8,
  /** A safety guard refused. Not a bug — the tool did its job. */
  safety: 9,
  /** CI mode: the run completed but graded below the configured threshold. */
  belowThreshold: 10,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const BY_ERROR_CODE: Readonly<Record<string, ExitCode>> = {
  ERR_VALIDATION: EXIT_CODES.usage,
  ERR_RUN: EXIT_CODES.run,
  ERR_INJECTION: EXIT_CODES.injection,
  ERR_REVERT: EXIT_CODES.revert,
  ERR_OBSERVATION: EXIT_CODES.observation,
  ERR_AGENT: EXIT_CODES.agent,
  ERR_AGENT_OUTPUT: EXIT_CODES.agent,
  ERR_REPORT: EXIT_CODES.report,
  ERR_SAFETY: EXIT_CODES.safety,
};

export function exitCodeFor(error: unknown): ExitCode {
  if (!isAlarmdrillError(error)) return EXIT_CODES.unexpected;
  return BY_ERROR_CODE[error.code] ?? EXIT_CODES.unexpected;
}
