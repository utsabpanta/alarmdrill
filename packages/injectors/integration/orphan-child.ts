/**
 * Deliberately abandons an injection.
 *
 * Journals a latency toxic, applies it, tells the parent it is live, then hangs
 * forever waiting to be SIGKILLed. Nothing here reverts — that is the point.
 */
import { createSilentLogger, systemClock } from '@alarmdrill/core';
import {
  createFileJournal,
  createInjectionSession,
  createLatencyInjector,
  createToxiproxyClient,
} from '@alarmdrill/injectors';

const [journalDir, baseUrl, proxy] = process.argv.slice(2);
if (journalDir === undefined || baseUrl === undefined || proxy === undefined) {
  throw new Error('usage: orphan-child <journalDir> <toxiproxyUrl> <proxyName>');
}

const client = createToxiproxyClient({ baseUrl });
const injector = createLatencyInjector(client);

const session = createInjectionSession({
  journal: createFileJournal({ dir: journalDir, clock: systemClock }),
  clock: systemClock,
  logger: createSilentLogger(),
  policy: { allow: [proxy] },
  registry: { [injector.kind]: injector },
});

await session.inject(injector, { proxy, latencyMs: 800 }, { maxDurationMs: 600_000 });

process.stdout.write('INJECTED\n');

// Hang. The parent will SIGKILL us, so no handler could save the toxic.
await new Promise(() => {});
