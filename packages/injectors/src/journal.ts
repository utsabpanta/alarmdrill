import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@alarmdrill/core';
import { z } from 'zod';
import { injectionError } from './errors.js';
import { journalEntrySchema, type JournalEntry, type RevertPlan } from './types.js';

/**
 * Journal before injecting. An unjournaled injection is an orphan waiting to
 * happen: if the process dies between breaking something and recording that it
 * broke it, nothing on earth knows how to put it back.
 *
 * One file per open injection. Completing an injection deletes its file, so
 * whatever files remain are exactly the injections that never got reverted.
 */
export interface Journal {
  readonly record: (entry: JournalEntry) => Promise<void>;
  readonly complete: (id: string) => Promise<void>;
  readonly listOpen: () => Promise<JournalEntry[]>;
}

export interface JournalDeps {
  readonly dir: string;
  readonly clock: Clock;
}

export function createFileJournal({ dir }: JournalDeps): Journal {
  const pathFor = (id: string): string => join(dir, `${id}.json`);

  return {
    record: async (entry) => {
      await mkdir(dir, { recursive: true });
      // Write-then-rename: a torn file would be worse than no file, because
      // sweep would fail to parse it and skip a fault that is still applied.
      const temp = `${pathFor(entry.id)}.tmp`;
      await writeFile(temp, JSON.stringify(entry, null, 2), 'utf8');
      await rename(temp, pathFor(entry.id));
    },

    complete: async (id) => {
      await rm(pathFor(id), { force: true });
    },

    listOpen: async () => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }

      const entries: JournalEntry[] = [];
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const raw = await readFile(join(dir, name), 'utf8');
        const parsed = journalEntrySchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          // Refuse to guess. A journal we cannot read means something is still
          // broken out there and we do not know what.
          throw injectionError(
            `unreadable journal entry ${name}: ${z.prettifyError(parsed.error)}`,
          );
        }
        entries.push(parsed.data);
      }
      return entries.sort((a, b) => a.journaledAt.localeCompare(b.journaledAt));
    },
  };
}

export function buildEntry(input: {
  id: string;
  plan: RevertPlan;
  maxDurationMs: number;
  clock: Clock;
}): JournalEntry {
  return {
    id: input.id,
    kind: input.plan.kind,
    target: input.plan.target,
    journaledAt: input.clock.now().toISOString(),
    maxDurationMs: input.maxDurationMs,
    plan: input.plan,
  };
}
