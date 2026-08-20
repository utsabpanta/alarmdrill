import { z } from 'zod';
import { observationError } from './errors.js';

/**
 * Alertmanager's v2 API. Every response is validated — this is an external
 * boundary, and an unrecognised shape must fail loudly rather than quietly
 * produce an empty alert list, which would score as a blind spot and be wrong.
 */
const alertSchema = z.object({
  fingerprint: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  status: z
    .object({
      state: z.string(),
      silencedBy: z.array(z.string()).default([]),
      inhibitedBy: z.array(z.string()).default([]),
    })
    .optional(),
});

const alertsSchema = z.array(alertSchema);

export type RawAlert = z.infer<typeof alertSchema>;

/** What an on-call engineer sees when they open the alert list. Nothing more. */
export interface ObservedAlert {
  readonly fingerprint: string;
  readonly alertname: string;
  readonly severity: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly startsAt: string;
  readonly silenced: boolean;
}

export interface AlertmanagerClient {
  readonly activeAlerts: () => Promise<ObservedAlert[]>;
}

export interface AlertmanagerDeps {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createAlertmanagerClient(deps: AlertmanagerDeps): AlertmanagerClient {
  const doFetch = deps.fetch ?? globalThis.fetch;

  return {
    activeAlerts: async () => {
      const url = `${deps.baseUrl}/api/v2/alerts?active=true&silenced=false&inhibited=false`;
      let response: Response;
      try {
        response = await doFetch(url, {
          signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
        });
      } catch (cause: unknown) {
        throw observationError(`alertmanager unreachable at ${deps.baseUrl}`, { cause });
      }
      if (!response.ok) {
        throw observationError(`alertmanager responded ${String(response.status)}`);
      }

      const parsed = alertsSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw observationError(
          `alertmanager returned an unexpected shape: ${z.prettifyError(parsed.error)}`,
        );
      }
      return parsed.data.map(toObserved);
    },
  };
}

export function toObserved(raw: RawAlert): ObservedAlert {
  return {
    fingerprint: raw.fingerprint,
    alertname: raw.labels['alertname'] ?? '(unnamed)',
    severity: raw.labels['severity'] ?? 'none',
    labels: raw.labels,
    annotations: raw.annotations,
    startsAt: raw.startsAt,
    silenced: (raw.status?.silencedBy.length ?? 0) > 0,
  };
}
