import type { LabConfig } from './config.js';

const PRODUCT_IDS = ['p1', 'p2', 'p3', 'p4'];
/** Reads dominate, as they do in real shops. Checkouts are the expensive path. */
const CHECKOUT_SHARE = 0.3;

/**
 * Steady synthetic traffic. Without it the lab has no baseline, and a fault
 * that stops requests from being served looks identical to a quiet Tuesday.
 *
 * Requests are fire-and-forget with their failures swallowed: the load
 * generator is a customer, not a monitor. Everything alarmdrill measures has to
 * come from the services' own telemetry.
 */
export function startLoadGenerator(config: LabConfig): () => Promise<void> {
  const intervalMs = Math.max(10, Math.round(1_000 / config.LOAD_RPS));

  const fire = (): void => {
    const target =
      Math.random() < CHECKOUT_SHARE
        ? { url: `${config.GATEWAY_URL}/checkout`, method: 'POST' }
        : {
            url: `${config.GATEWAY_URL}/products/${pickProduct()}`,
            method: 'GET',
          };

    void fetch(target.url, {
      method: target.method,
      signal: AbortSignal.timeout(8_000),
      ...(target.method === 'POST'
        ? { headers: { 'content-type': 'application/json' }, body: '{}' }
        : {}),
    })
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
  };

  const handle = setInterval(fire, intervalMs);
  return () => {
    clearInterval(handle);
    return Promise.resolve();
  };
}

function pickProduct(): string {
  const index = Math.floor(Math.random() * PRODUCT_IDS.length);
  return PRODUCT_IDS[index] ?? 'p1';
}
