import { Pool } from 'pg';
import { fetchJson, type ServiceDefinition } from '../http.js';
import { createPoolMetrics } from '../metrics.js';

interface PaymentResponse {
  settled: boolean;
  outcome: string;
  reference: string;
}

/**
 * Places an order: write it, charge it, mark it.
 *
 * The Postgres pool here is small and its depth is instrumented, but no rule
 * reads the gauge — saturating it only becomes visible once the knock-on
 * latency crosses the unrelated gateway threshold. That lateness is the point.
 */
export function createCheckoutService(): ServiceDefinition {
  let pool: Pool | undefined;

  return {
    service: 'checkout',
    routes: (app, ctx) => {
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

      app.post('/orders', async (_request, reply) => {
        const created = await activePool.query<{ id: string }>(
          "insert into orders (status) values ('pending') returning id",
        );
        const orderId = created.rows[0]?.id;
        if (orderId === undefined) {
          return await reply.code(500).send({ error: 'order_not_created' });
        }

        const payment = await fetchJson<PaymentResponse>(`${ctx.config.PAYMENTS_URL}/charge`, {
          method: 'POST',
          body: { orderId },
          timeoutMs: 4_000,
        });

        // A declined payment leaves the order unpaid and answers 200. Nothing
        // in the telemetry distinguishes this from a completed sale.
        await activePool.query('update orders set status = $1 where id = $2', [
          payment.settled ? 'paid' : 'declined',
          orderId,
        ]);

        return { orderId, settled: payment.settled };
      });
    },
    dispose: async () => {
      await pool?.end();
    },
  };
}
