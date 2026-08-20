import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { agentError, agentOutputError } from './errors.js';

/**
 * Every model call in alarmdrill goes through this one interface, so tests can
 * substitute a fake and never touch a real model (SPEC.md, "Decisions already
 * made"). It is also the only place the Anthropic SDK is imported.
 */
export interface ModelRequest<T> {
  readonly system: string;
  readonly user: string;
  readonly schema: z.ZodType<T>;
  readonly maxTokens?: number;
}

export interface ModelClient {
  readonly name: string;
  readonly complete: <T>(request: ModelRequest<T>) => Promise<T>;
}

export const DEFAULT_MODEL = 'claude-opus-5';

export interface AnthropicModelDeps {
  readonly client?: Anthropic;
  readonly model?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export function createAnthropicModel(deps: AnthropicModelDeps = {}): ModelClient {
  const model = deps.model ?? DEFAULT_MODEL;
  const client = deps.client ?? new Anthropic();

  return {
    name: model,
    complete: async <T>(request: ModelRequest<T>): Promise<T> => {
      let response;
      try {
        response = await client.messages.parse({
          model,
          max_tokens: request.maxTokens ?? 16_000,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          // Note: temperature is not a knob on this model family — it is
          // rejected outright. Grading stability comes from voting instead
          // (see grader.ts), which is a better answer anyway.
          output_config: {
            effort: deps.effort ?? 'high',
            format: zodOutputFormat(request.schema),
          },
        });
      } catch (cause: unknown) {
        throw agentError(`model call failed (${model})`, { cause });
      }

      if (response.stop_reason === 'refusal') {
        throw agentError(`model refused to answer: ${response.stop_details?.explanation ?? ''}`);
      }

      const parsed: unknown = response.parsed_output;
      if (parsed === null || parsed === undefined) {
        throw agentOutputError(`model returned no parseable output (${model})`);
      }

      // Never trust the shape, even after the SDK has parsed it
      // (CLAUDE.md, hard rule 6).
      const validated = request.schema.safeParse(parsed);
      if (!validated.success) {
        throw agentOutputError(`model output did not match its schema`);
      }
      return validated.data;
    },
  };
}

export interface FakeModelDeps {
  /** Returned in order; the last one repeats once exhausted. */
  readonly responses: readonly unknown[];
  readonly onCall?: (request: ModelRequest<unknown>) => void;
}

/**
 * The model stand-in used by every test. No network, no key, no cost, and it
 * records what it was asked — which is how the blinding tests inspect the
 * prompt that would have been sent.
 */
export function createFakeModel(deps: FakeModelDeps): ModelClient & { callCount: () => number } {
  let calls = 0;

  return {
    name: 'fake',
    callCount: () => calls,
    complete: <T>(request: ModelRequest<T>): Promise<T> => {
      deps.onCall?.(request);
      const response = deps.responses[Math.min(calls, deps.responses.length - 1)];
      calls += 1;

      const validated = request.schema.safeParse(response);
      if (!validated.success) {
        return Promise.reject(
          agentOutputError('fake model was given a response that does not match the schema'),
        );
      }
      return Promise.resolve(validated.data);
    },
  };
}
