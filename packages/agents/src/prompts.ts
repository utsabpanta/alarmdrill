import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentError } from './errors.js';

/**
 * Prompts are versioned files, never inline strings: a run graded last month
 * was graded under last month's prompt, and the trace has to name which one
 * (SPEC.md, "Decisions already made").
 *
 * Bumping a prompt means adding `name.v2.md`, not editing `name.v1.md`.
 */
export type PromptName = 'diagnostician' | 'grader';

export interface LoadedPrompt {
  readonly name: PromptName;
  readonly version: string;
  readonly text: string;
}

const PROMPT_DIR = new URL('../prompts/', import.meta.url);

export const CURRENT_PROMPT_VERSIONS: Readonly<Record<PromptName, string>> = {
  diagnostician: 'v1',
  grader: 'v1',
};

export function loadPrompt(name: PromptName, version?: string): LoadedPrompt {
  const resolved = version ?? CURRENT_PROMPT_VERSIONS[name];
  const path = fileURLToPath(new URL(`${name}.${resolved}.md`, PROMPT_DIR));
  try {
    return { name, version: resolved, text: readFileSync(path, 'utf8') };
  } catch (cause: unknown) {
    throw agentError(`prompt ${name}.${resolved} not found — prompts are versioned files`, {
      cause,
    });
  }
}
