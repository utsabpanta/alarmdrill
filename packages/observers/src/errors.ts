import { defineError } from '@alarmdrill/core';

/**
 * This package must never import `@alarmdrill/injectors`, directly or
 * transitively. It builds the evidence bundle the diagnostician sees, and any
 * knowledge of the injected fault leaking in here fails silently — the tool
 * would report excellent observability for systems that have none.
 * See SPEC.md, "Two things that must not break".
 */
export const observationError = defineError('ERR_OBSERVATION');
