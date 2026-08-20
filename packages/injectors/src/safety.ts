import { safetyError } from '@alarmdrill/core';

/**
 * We break things on purpose, so the guard against breaking the wrong thing is
 * the most important code in the package.
 *
 * Two independent conditions, and both must hold: the target is explicitly
 * allowlisted, AND it does not look like production. Deny always beats allow —
 * an allowlist entry cannot authorise something named `payments-prod`, because
 * the most likely reason for that combination is a mistake.
 *
 * Never widen these to make a test pass (CLAUDE.md, hard rule 7).
 */
export const PRODUCTION_PATTERNS: readonly RegExp[] = [
  /prod/i,
  /production/i,
  /\bprd\b/i,
  /\blive\b/i,
  /customer/i,
];

export interface TargetPolicy {
  /** Exact target names that may be broken. No wildcards, on purpose. */
  readonly allow: readonly string[];
  /** Extra refusal patterns, added to PRODUCTION_PATTERNS rather than replacing them. */
  readonly denyPatterns?: readonly RegExp[];
}

export function assertTargetAllowed(target: string, policy: TargetPolicy): void {
  const denied = [...PRODUCTION_PATTERNS, ...(policy.denyPatterns ?? [])].find((pattern) =>
    pattern.test(target),
  );
  if (denied !== undefined) {
    throw safetyError(
      `refusing to inject into "${target}": it matches ${String(denied)}, which looks like production`,
    );
  }

  if (!policy.allow.includes(target)) {
    throw safetyError(
      `refusing to inject into "${target}": not in the target allowlist [${policy.allow.join(', ')}]`,
    );
  }
}
