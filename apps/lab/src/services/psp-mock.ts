import { z } from 'zod';
import type { ServiceDefinition } from '../http.js';

const controlSchema = z.object({ declineRate: z.number().min(0).max(1) });

/**
 * Stands in for a third-party payment processor.
 *
 * Two things matter here. It always answers HTTP 200 — a decline is a business
 * outcome, not a transport error, which is exactly why it slips past every
 * status-code-based alert. And it exposes a control endpoint that the M2
 * http-fault injector uses to change the decline rate; that endpoint is the
 * injection mechanism, never part of the evidence the diagnostician sees.
 */
export function createPspMockService(): ServiceDefinition {
  return {
    service: 'psp-mock',
    routes: (app, ctx) => {
      let declineRate = ctx.config.PSP_DECLINE_RATE;

      app.post('/charge', () => ({
        outcome: Math.random() < declineRate ? 'declined' : 'approved',
        processorReference: `psp_${Math.random().toString(36).slice(2, 10)}`,
      }));

      app.put('/_control/decline-rate', async (request, reply) => {
        const parsed = controlSchema.safeParse(request.body);
        if (!parsed.success) {
          return await reply.code(400).send({ error: 'invalid_control_payload' });
        }
        declineRate = parsed.data.declineRate;
        return { declineRate };
      });

      app.get('/_control/decline-rate', () => ({ declineRate }));
    },
  };
}
