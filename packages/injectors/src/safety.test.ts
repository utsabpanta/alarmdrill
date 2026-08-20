import { hasErrorCode } from '@alarmdrill/core';
import { describe, expect, it } from 'vitest';
import { assertTargetAllowed, type TargetPolicy } from './safety.js';

const policy: TargetPolicy = { allow: ['alarmdrill-lab-payments', 'checkout-to-payments'] };

describe('assertTargetAllowed', () => {
  it('permits an allowlisted target', () => {
    expect(() => assertTargetAllowed('alarmdrill-lab-payments', policy)).not.toThrow();
  });

  it('refuses anything not allowlisted', () => {
    expect(() => assertTargetAllowed('some-other-container', policy)).toThrow(/allowlist/);
  });

  // The important one: an allowlist entry must not be able to authorise
  // something that looks like production. Deny beats allow, always.
  it.each([
    'payments-prod',
    'checkout-PRODUCTION',
    'svc-prd-1',
    'live-gateway',
    'customer-facing-api',
  ])('refuses %s even when it is explicitly allowlisted', (target) => {
    expect(() => assertTargetAllowed(target, { allow: [target] })).toThrow(/looks like production/);
  });

  it('raises a safety error, not a generic one, so the CLI can exit distinctly', () => {
    try {
      assertTargetAllowed('payments-prod', { allow: ['payments-prod'] });
      expect.unreachable('should have refused');
    } catch (error: unknown) {
      expect(hasErrorCode(error, 'ERR_SAFETY')).toBe(true);
    }
  });

  it('adds caller patterns to the built-in ones rather than replacing them', () => {
    const extended: TargetPolicy = { allow: ['staging-db'], denyPatterns: [/db/] };
    expect(() => assertTargetAllowed('staging-db', extended)).toThrow(/looks like production/);
    // built-ins still active
    expect(() => assertTargetAllowed('anything-prod', extended)).toThrow(/looks like production/);
  });
});
