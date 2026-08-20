import { fetchJson, type ServiceDefinition } from '../http.js';

interface PspResponse {
  outcome: 'approved' | 'declined';
  processorReference: string;
}

/**
 * Charges a card via the PSP.
 *
 * PLANTED GAP — missing instrumentation, not a missing rule.
 *
 * This service knows whether every single charge was approved or declined and
 * counts none of it. There is no `payments_charges_total{outcome=...}` here,
 * and adding one would delete the most interesting finding in the demo: a
 * fault that no alert rule could possibly catch, because the data does not
 * exist. See ../README.md before you "fix" this.
 */
export function createPaymentsService(): ServiceDefinition {
  return {
    service: 'payments',
    routes: (app, ctx) => {
      app.post('/charge', async (_request, reply) => {
        const psp = await fetchJson<PspResponse>(`${ctx.config.PSP_URL}/charge`, {
          method: 'POST',
          body: { amountCents: 1_299 },
          timeoutMs: 4_000,
        });

        // A decline is a 200. The customer's order fails; the monitoring sees
        // a perfectly healthy service.
        return await reply.code(200).send({
          settled: psp.outcome === 'approved',
          outcome: psp.outcome,
          reference: psp.processorReference,
        });
      });
    },
  };
}
