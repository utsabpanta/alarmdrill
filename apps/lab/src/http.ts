import Fastify, { type FastifyInstance } from 'fastify';
import type { LabConfig, ServiceName } from './config.js';
import { createMetrics, type LabMetrics } from './metrics.js';

export interface ServiceContext {
  readonly service: ServiceName;
  readonly config: LabConfig;
  readonly metrics: LabMetrics;
}

export interface ServiceDefinition {
  readonly service: ServiceName;
  /** Registers routes. Anything returned is disposed on shutdown. */
  readonly routes: (app: FastifyInstance, ctx: ServiceContext) => void | Promise<void>;
  readonly dispose?: () => Promise<void>;
}

export async function startService(
  definition: ServiceDefinition,
  config: LabConfig,
): Promise<() => Promise<void>> {
  const metrics = createMetrics(definition.service);
  const ctx: ServiceContext = { service: definition.service, config, metrics };

  const app = Fastify({
    logger: { level: config.LOG_LEVEL, base: { service: definition.service } },
    disableRequestLogging: true,
  });

  app.addHook('onResponse', (request, reply, done) => {
    metrics.observeHttp(
      {
        method: request.method,
        // Route template, not the raw URL — keeps label cardinality bounded.
        route: request.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
      },
      reply.elapsedTime / 1000,
    );
    done();
  });

  app.get('/health', () => ({ status: 'ok', service: definition.service }));

  app.get('/metrics', async (_request, reply) => {
    reply.type(metrics.registry.contentType);
    return await metrics.registry.metrics();
  });

  await definition.routes(app, ctx);
  await app.listen({ host: '0.0.0.0', port: config.PORT });

  return async () => {
    await app.close();
    await definition.dispose?.();
  };
}

export interface JsonRequest {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Node 22 ships fetch, so there is no HTTP client dependency to keep current.
 * Every call is bounded — a hung upstream must surface as a fast failure, not
 * as a stuck request that quietly changes what the fault looks like.
 */
export async function fetchJson<T>(url: string, request: JsonRequest = {}): Promise<T> {
  const response = await fetch(url, {
    method: request.method ?? 'GET',
    signal: AbortSignal.timeout(request.timeoutMs ?? 5_000),
    ...(request.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) }),
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${String(response.status)}`);
  }
  return (await response.json()) as T;
}
