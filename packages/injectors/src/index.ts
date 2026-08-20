import { defineError } from '@alarmdrill/core';

/** Applying a fault failed. The journal entry is already on disk by this point. */
export const injectionError = defineError('ERR_INJECTION');

/**
 * A revert could not be completed. This is the loudest failure in the system —
 * something is still broken in the target environment.
 */
export const revertError = defineError('ERR_REVERT');

/** Placeholder until M2. Toxiproxy and Docker injectors land there. */
export const INJECTORS_PACKAGE = '@alarmdrill/injectors';
