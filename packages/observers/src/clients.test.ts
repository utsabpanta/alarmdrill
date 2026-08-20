import { hasErrorCode } from '@alarmdrill/core';
import { describe, expect, it } from 'vitest';
import { createAlertmanagerClient } from './alertmanager.js';
import { createPrometheusClient } from './prometheus.js';

const json = (body: unknown): typeof globalThis.fetch => () => Promise.resolve(Response.json(body));

/** Captured verbatim from alertmanager v0.28.1 running in the lab. */
const REAL_ALERT = {
  annotations: { summary: 'payments resident memory above 25MB' },
  endsAt: '2026-08-20T21:22:06.311Z',
  fingerprint: '47432aeff71bde7c',
  generatorURL: 'http://prometheus:9090/graph',
  labels: {
    alertname: 'HighMemoryUsage',
    instance: 'payments:3002',
    job: 'payments',
    service: 'payments',
    severity: 'warning',
  },
  receivers: [{ name: 'blackhole' }],
  startsAt: '2026-08-20T21:18:06.311Z',
  status: { inhibitedBy: [], mutedBy: [], silencedBy: [], state: 'active' },
  updatedAt: '2026-08-20T21:18:06.311Z',
};

describe('alertmanager client', () => {
  it('parses a real alert and ignores fields it does not model', async () => {
    const client = createAlertmanagerClient({ baseUrl: 'http://am:9093', fetch: json([REAL_ALERT]) });
    const [alert] = await client.activeAlerts();

    expect(alert).toMatchObject({
      alertname: 'HighMemoryUsage',
      severity: 'warning',
      fingerprint: '47432aeff71bde7c',
      silenced: false,
    });
  });

  it('marks a silenced alert, so detection can discount it', async () => {
    const silenced = { ...REAL_ALERT, status: { ...REAL_ALERT.status, silencedBy: ['sil-1'] } };
    const client = createAlertmanagerClient({ baseUrl: 'http://am:9093', fetch: json([silenced]) });
    expect((await client.activeAlerts())[0]?.silenced).toBe(true);
  });

  // An empty list and a broken parse look identical downstream — both produce
  // "no alerts" — but one means a blind spot and the other means a bug.
  it('fails loudly rather than returning no alerts when the shape is wrong', async () => {
    const client = createAlertmanagerClient({
      baseUrl: 'http://am:9093',
      fetch: json([{ labels: 'not-an-object' }]),
    });
    await expect(client.activeAlerts()).rejects.toThrow(/unexpected shape/);
  });

  it('raises ERR_OBSERVATION when alertmanager is unreachable', async () => {
    const client = createAlertmanagerClient({
      baseUrl: 'http://am:9093',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    try {
      await client.activeAlerts();
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(hasErrorCode(error, 'ERR_OBSERVATION')).toBe(true);
    }
  });
});

describe('prometheus client', () => {
  const range = { from: new Date('2026-01-01T12:00:00Z'), to: new Date('2026-01-01T12:02:00Z') };

  it('converts a matrix response into typed series', async () => {
    const client = createPrometheusClient({
      baseUrl: 'http://prom:9090',
      fetch: json({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { service: 'catalog', result: 'error' },
              values: [
                [1787260671, '0.039'],
                [1787260701, '1.5'],
              ],
            },
          ],
        },
      }),
    });

    const [series] = await client.queryRange('anything', range);
    expect(series?.labels).toEqual({ service: 'catalog', result: 'error' });
    // Prometheus returns values as strings; they must arrive as numbers.
    expect(series?.samples.map((s) => s.value)).toEqual([0.039, 1.5]);
    expect(series?.samples[0]?.at).toBe(new Date(1787260671 * 1000).toISOString());
  });

  it('converts a vector response into single-sample series', async () => {
    const client = createPrometheusClient({
      baseUrl: 'http://prom:9090',
      fetch: json({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: { job: 'catalog' }, value: [1787260701.743, '1'] }],
        },
      }),
    });

    const [series] = await client.queryInstant('up');
    expect(series?.samples).toHaveLength(1);
    expect(series?.samples[0]?.value).toBe(1);
  });

  it('returns an empty list for a query that matched nothing', async () => {
    // A metric that does not exist is a finding, not an error.
    const client = createPrometheusClient({
      baseUrl: 'http://prom:9090',
      fetch: json({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    });
    await expect(client.queryRange('payments_charges_total', range)).resolves.toEqual([]);
  });

  it('rejects a response whose shape it does not recognise', async () => {
    const client = createPrometheusClient({
      baseUrl: 'http://prom:9090',
      fetch: json({ status: 'error', errorType: 'bad_data' }),
    });
    await expect(client.queryRange('up', range)).rejects.toThrow(/unexpected shape/);
  });
});
