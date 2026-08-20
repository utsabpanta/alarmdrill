import { hasErrorCode } from '@alarmdrill/core';
import { describe, expect, it } from 'vitest';
import { createToxiproxyClient } from './toxiproxy.js';

const PROXY = {
  name: 'checkout-to-payments',
  listen: '[::]:18002',
  upstream: 'payments:3002',
  enabled: true,
  // The real server returns this field; we neither model nor depend on it.
  Logger: {},
  toxics: [],
};

function fakeFetch(handler: () => Response): typeof globalThis.fetch {
  return () => Promise.resolve(handler());
}

const client = (fetchImpl: typeof globalThis.fetch) =>
  createToxiproxyClient({ baseUrl: 'http://toxiproxy:8474', fetch: fetchImpl });

describe('toxiproxy client', () => {
  it('parses a proxy and tolerates fields it does not model', async () => {
    const c = client(fakeFetch(() => Response.json(PROXY)));
    await expect(c.getProxy('checkout-to-payments')).resolves.toMatchObject({
      name: 'checkout-to-payments',
      enabled: true,
    });
  });

  it('rejects a response whose shape changed rather than trusting it', async () => {
    const c = client(fakeFetch(() => Response.json({ name: 'x', enabled: 'yes' })));
    await expect(c.getProxy('x')).rejects.toThrow(/unexpected proxy shape/);
  });

  // Verified against toxiproxy 2.12.0: a second DELETE returns 404. Revert is
  // called by the happy path, the deadman timer and crash recovery, so treating
  // 404 as failure would turn normal operation into a spurious ERR_REVERT.
  it('treats deleting an already-deleted toxic as success', async () => {
    const c = client(fakeFetch(() => new Response('{"error":"toxic not found"}', { status: 404 })));
    await expect(c.removeToxic('p', 'alarmdrill-latency-p')).resolves.toBeUndefined();
  });

  it('treats a 204 delete as success', async () => {
    const c = client(fakeFetch(() => new Response(null, { status: 204 })));
    await expect(c.removeToxic('p', 't')).resolves.toBeUndefined();
  });

  it('raises ERR_REVERT when the server genuinely fails to remove a toxic', async () => {
    const c = client(fakeFetch(() => new Response('boom', { status: 500 })));
    try {
      await c.removeToxic('p', 't');
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(hasErrorCode(error, 'ERR_REVERT')).toBe(true);
    }
  });

  it('raises ERR_INJECTION when the server refuses a toxic', async () => {
    const c = client(fakeFetch(() => new Response('bad toxic', { status: 400 })));
    try {
      await c.addToxic('p', {
        name: 't', type: 'latency', stream: 'downstream', toxicity: 1, attributes: {},
      });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(hasErrorCode(error, 'ERR_INJECTION')).toBe(true);
    }
  });
});
