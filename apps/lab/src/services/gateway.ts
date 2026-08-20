import { fetchJson, type ServiceDefinition } from '../http.js';

interface OrderResponse {
  orderId: string;
  settled: boolean;
}

interface ProductResponse {
  id: string;
  name: string;
  priceCents: number;
}

/**
 * The public edge. Everything a synthetic user does enters here, which makes
 * it the only place the lab's latency alert looks — and that alert cannot say
 * which downstream hop actually got slow.
 */
export function createGatewayService(): ServiceDefinition {
  return {
    service: 'gateway',
    routes: (app, ctx) => {
      app.post('/checkout', async () => {
        return await fetchJson<OrderResponse>(`${ctx.config.CHECKOUT_URL}/orders`, {
          method: 'POST',
          body: {},
          timeoutMs: 5_000,
        });
      });

      app.get('/products/:id', async (request) => {
        const { id } = request.params as { id: string };
        return await fetchJson<ProductResponse>(`${ctx.config.CATALOG_URL}/products/${id}`, {
          timeoutMs: 5_000,
        });
      });
    },
  };
}
