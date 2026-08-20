// Named import, not default: ioredis is CJS and its `module.exports` is the
// namespace object, so a default import would not be constructable at runtime.
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import type { ServiceDefinition } from '../http.js';
import { createCacheMetrics, createPoolMetrics } from '../metrics.js';
import { lookupProduct, type CatalogPorts, type Product } from './catalog-lookup.js';

const CACHE_TTL_SECONDS = 30;

export function createCatalogService(): ServiceDefinition {
  let redis: Redis | undefined;
  let pool: Pool | undefined;

  return {
    service: 'catalog',
    routes: (app, ctx) => {
      // Fail fast rather than queue: when Redis is stopped, the fallback must
      // be quick enough that latency alone never trips an alert.
      redis = new Redis(ctx.config.REDIS_URL, {
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        commandTimeout: 200,
        retryStrategy: () => 1_000,
        lazyConnect: true,
      });
      redis.on('error', () => {
        // Swallowed on purpose — an unhandled 'error' would crash the process
        // and turn an invisible fault into a very visible one.
      });
      void redis.connect().catch(() => undefined);

      pool = new Pool({
        connectionString: ctx.config.DATABASE_URL,
        max: ctx.config.DB_POOL_SIZE,
        connectionTimeoutMillis: 3_000,
      });
      const activePool = pool;
      createPoolMetrics(ctx.metrics.registry, () => ({
        total: activePool.totalCount,
        idle: activePool.idleCount,
        waiting: activePool.waitingCount,
      }));

      const cache = createCacheMetrics(ctx.metrics.registry);
      const activeRedis = redis;

      const ports: CatalogPorts = {
        cacheGet: async (id) => {
          const raw = await activeRedis.get(`product:${id}`);
          return raw === null ? null : (JSON.parse(raw) as Product);
        },
        cacheSet: async (id, product) => {
          await activeRedis.set(`product:${id}`, JSON.stringify(product), 'EX', CACHE_TTL_SECONDS);
        },
        dbGet: async (id) => {
          const result = await activePool.query<Product>(
            'select id, name, price_cents as "priceCents" from products where id = $1',
            [id],
          );
          return result.rows[0] ?? null;
        },
        recordLookup: cache.recordLookup,
      };

      app.get('/products/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const product = await lookupProduct(ports, id);
        if (product === null) {
          return await reply.code(404).send({ error: 'not_found' });
        }
        return product;
      });
    },
    dispose: async () => {
      redis?.disconnect();
      await pool?.end();
    },
  };
}
