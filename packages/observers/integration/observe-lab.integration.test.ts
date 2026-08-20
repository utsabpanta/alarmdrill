import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildEvidenceBundle,
  collectMetrics,
  createAlertmanagerClient,
  createPrometheusClient,
} from '../src/index.js';

/**
 * Parses what the real lab actually emits. The unit tests use payloads captured
 * from these same services, but a capture goes stale — this keeps the schemas
 * honest against the running versions.
 *
 * Needs `pnpm lab:up`.
 */
const ALERTMANAGER = process.env['ALERTMANAGER_URL'] ?? 'http://localhost:9093';
const PROMETHEUS = process.env['PROMETHEUS_URL'] ?? 'http://localhost:9090';

let reachable = false;

beforeAll(async () => {
  try {
    const [am, prom] = await Promise.all([
      fetch(`${ALERTMANAGER}/api/v2/status`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${PROMETHEUS}/-/ready`, { signal: AbortSignal.timeout(2_000) }),
    ]);
    reachable = am.ok && prom.ok;
  } catch {
    reachable = false;
  }
});

const requireLab = (): void => {
  if (!reachable) {
    throw new Error(
      `lab not reachable (${ALERTMANAGER}, ${PROMETHEUS}). Run 'pnpm lab:up' first.`,
    );
  }
};

describe('observing the real lab', () => {
  it('parses live alertmanager alerts', async () => {
    requireLab();
    const client = createAlertmanagerClient({ baseUrl: ALERTMANAGER });
    const alerts = await client.activeAlerts();

    // The lab's chronically-noisy memory alert is always firing, which is
    // exactly why it makes a dependable fixture.
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.map((a) => a.alertname)).toContain('HighMemoryUsage');
    for (const alert of alerts) {
      expect(alert.fingerprint).not.toBe('');
      expect(Number.isNaN(Date.parse(alert.startsAt))).toBe(false);
    }
  }, 60_000);

  it('runs every standard query against live prometheus', async () => {
    requireLab();
    const prometheus = createPrometheusClient({ baseUrl: PROMETHEUS });
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 60_000);

    // Each query must at least parse. Empty results are legitimate — a metric
    // that does not exist is a finding, not a failure.
    const metrics = await collectMetrics({ prometheus, window: { from, to }, stepSeconds: 30 });

    expect(metrics).toHaveLength(6);
    const up = metrics.find((m) => m.query === 'up');
    expect(up?.series.length).toBeGreaterThan(0);
    expect(up?.series[0]?.samples.every((s) => Number.isFinite(s.value))).toBe(true);
  }, 60_000);

  it('builds a bundle from live data that still leaks nothing', async () => {
    requireLab();
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 60_000);
    const bundle = buildEvidenceBundle({
      window: { from, to },
      alerts: await createAlertmanagerClient({ baseUrl: ALERTMANAGER }).activeAlerts(),
      metrics: await collectMetrics({
        prometheus: createPrometheusClient({ baseUrl: PROMETHEUS }),
        window: { from, to },
        stepSeconds: 60,
      }),
      services: ['gateway', 'checkout', 'payments', 'catalog', 'psp-mock'],
    });

    const serialized = JSON.stringify(bundle).toLowerCase();
    for (const term of ['toxiproxy', 'inject', 'fault', 'revert', 'alarmdrill']) {
      expect(serialized, `live bundle leaked "${term}"`).not.toContain(term);
    }
  }, 60_000);
});
