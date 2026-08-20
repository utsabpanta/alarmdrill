import { z } from 'zod';
import { observationError } from './errors.js';

/**
 * Prometheus HTTP API. Shapes confirmed against Prometheus v3.6.0: a sample is
 * a [unixSeconds, "stringValue"] pair, and the value really is a string.
 */
const sampleSchema = z.tuple([z.number(), z.string()]);

const vectorResultSchema = z.object({
  metric: z.record(z.string(), z.string()),
  value: sampleSchema,
});

const matrixResultSchema = z.object({
  metric: z.record(z.string(), z.string()),
  values: z.array(sampleSchema),
});

const responseSchema = z.object({
  status: z.literal('success'),
  data: z.union([
    z.object({ resultType: z.literal('vector'), result: z.array(vectorResultSchema) }),
    z.object({ resultType: z.literal('matrix'), result: z.array(matrixResultSchema) }),
  ]),
});

export interface MetricSample {
  readonly at: string;
  readonly value: number;
}

export interface MetricSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly samples: readonly MetricSample[];
}

export interface PrometheusClient {
  readonly queryRange: (query: string, range: TimeRange, stepSeconds?: number) => Promise<MetricSeries[]>;
  readonly queryInstant: (query: string) => Promise<MetricSeries[]>;
}

export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

export interface PrometheusDeps {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const toSample = ([seconds, value]: [number, string]): MetricSample => ({
  at: new Date(seconds * 1_000).toISOString(),
  value: Number(value),
});

export function createPrometheusClient(deps: PrometheusDeps): PrometheusClient {
  const doFetch = deps.fetch ?? globalThis.fetch;

  const request = async (path: string, params: URLSearchParams): Promise<MetricSeries[]> => {
    const url = `${deps.baseUrl}${path}?${params.toString()}`;
    let response: Response;
    try {
      response = await doFetch(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    } catch (cause: unknown) {
      throw observationError(`prometheus unreachable at ${deps.baseUrl}`, { cause });
    }
    if (!response.ok) {
      throw observationError(
        `prometheus responded ${String(response.status)} for query ${params.get('query') ?? '?'}`,
      );
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw observationError(
        `prometheus returned an unexpected shape: ${z.prettifyError(parsed.error)}`,
      );
    }

    const { data } = parsed.data;
    return data.resultType === 'vector'
      ? data.result.map((r) => ({ labels: r.metric, samples: [toSample(r.value)] }))
      : data.result.map((r) => ({ labels: r.metric, samples: r.values.map(toSample) }));
  };

  return {
    queryInstant: (query) => request('/api/v1/query', new URLSearchParams({ query })),

    queryRange: (query, range, stepSeconds = 15) =>
      request(
        '/api/v1/query_range',
        new URLSearchParams({
          query,
          start: String(Math.floor(range.from.getTime() / 1_000)),
          end: String(Math.floor(range.to.getTime() / 1_000)),
          step: String(stepSeconds),
        }),
      ),
  };
}
