import { safetyError, validationError } from '@alarmdrill/core';
import { injectionError, revertError } from '@alarmdrill/injectors';
import { describe, expect, it } from 'vitest';
import { EXIT_CODES, exitCodeFor } from './exit-codes.js';

describe('exitCodeFor', () => {
  it('maps typed errors to their reserved codes', () => {
    expect(exitCodeFor(validationError('bad config'))).toBe(EXIT_CODES.usage);
    expect(exitCodeFor(safetyError('target looks like prod'))).toBe(EXIT_CODES.safety);
    expect(exitCodeFor(injectionError('toxiproxy refused'))).toBe(EXIT_CODES.injection);
    expect(exitCodeFor(revertError('toxic still present'))).toBe(EXIT_CODES.revert);
  });

  it('never reports success for an unknown throw', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(EXIT_CODES.unexpected);
    expect(exitCodeFor('boom')).toBe(EXIT_CODES.unexpected);
    expect(exitCodeFor(undefined)).toBe(EXIT_CODES.unexpected);
  });

  it('keeps every exit code distinct', () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
