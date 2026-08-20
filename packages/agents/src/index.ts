import { defineError } from '@alarmdrill/core';

/** The model call itself failed (transport, auth, rate limit). */
export const agentError = defineError('ERR_AGENT');

/** The model returned something that did not match its schema. */
export const agentOutputError = defineError('ERR_AGENT_OUTPUT');

/** Placeholder until M4. Prompts live in `prompts/` as versioned files. */
export const AGENTS_PACKAGE = '@alarmdrill/agents';
