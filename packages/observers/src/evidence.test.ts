import { describe, expect, it } from 'vitest';
import type { ObservedAlert } from './alertmanager.js';
import { buildEvidenceBundle, STANDARD_QUERIES } from './evidence.js';

const alert = (name: string): ObservedAlert => ({
  fingerprint: `fp-${name}`,
  alertname: name,
  severity: 'warning',
  labels: { alertname: name, service: 'catalog' },
  annotations: { summary: `${name} summary` },
  startsAt: '2026-01-01T12:00:30.000Z',
  silenced: false,
});

const input = {
  window: { from: new Date('2026-01-01T11:55:00Z'), to: new Date('2026-01-01T12:10:00Z') },
  alerts: [alert('ServiceDown'), alert('HighMemoryUsage')],
  metrics: [
    {
      query: 'up',
      description: 'scrape health per service',
      series: [{ labels: { job: 'catalog' }, samples: [{ at: '2026-01-01T12:00:00Z', value: 1 }] }],
    },
  ],
  services: ['payments', 'catalog', 'gateway'],
};

describe('buildEvidenceBundle', () => {
  it('carries only what an on-call engineer would see', () => {
    const bundle = buildEvidenceBundle(input);
    expect(Object.keys(bundle).sort()).toEqual([
      'firingAlerts',
      'metrics',
      'schemaVersion',
      'services',
      'window',
    ]);
  });

  it('orders alerts by name, not by arrival', () => {
    // Arrival order would hint at which alert fired first and therefore at what
    // broke — a detail the diagnostician has not earned.
    const bundle = buildEvidenceBundle(input);
    expect(bundle.firingAlerts.map((a) => a.alertname)).toEqual([
      'HighMemoryUsage',
      'ServiceDown',
    ]);
  });

  it('sorts services so the prompt is stable across runs', () => {
    expect(buildEvidenceBundle(input).services).toEqual(['catalog', 'gateway', 'payments']);
  });

  /**
   * The blinding guarantee, enforced on the actual bytes.
   *
   * If any of this vocabulary can reach a bundle, the diagnostician is being
   * told what broke and every grade this tool produces is meaningless — and it
   * would fail silently, reporting excellent observability for systems that
   * have none. See SPEC.md, "Two things that must not break".
   */
  it('contains no injector vocabulary anywhere in its serialized form', () => {
    const serialized = JSON.stringify(buildEvidenceBundle(input)).toLowerCase();

    const forbidden = [
      'inject', 'injector', 'injection',
      'fault', 'toxic', 'toxiproxy',
      'revert', 'journal', 'deadman',
      'experiment', 'suite',
      'groundtruth', 'ground_truth', 'expected',
      'declinerate', 'decline_rate',
      'alarmdrill',
    ];

    for (const term of forbidden) {
      expect(serialized, `evidence bundle leaked "${term}"`).not.toContain(term);
    }
  });

  it('exposes no field that could carry an injection timestamp', () => {
    const bundle = buildEvidenceBundle(input);
    const keys = JSON.stringify(bundle).match(/"[a-zA-Z]+":/g) ?? [];
    const timingKeys = keys.filter((k) => /injected|appliedat|faultat|startedat/i.test(k));
    expect(timingKeys).toEqual([]);
  });
});

describe('STANDARD_QUERIES', () => {
  it('asks the questions a dashboard would, not questions aimed at a fault', () => {
    const text = STANDARD_QUERIES.map((q) => `${q.query} ${q.description}`).join(' ').toLowerCase();
    // A query naming the thing we broke would hand over the answer.
    for (const term of ['toxic', 'inject', 'fault', 'stopped', 'declined']) {
      expect(text, `a standard query mentions "${term}"`).not.toContain(term);
    }
  });

  it('includes the signals the lab deliberately leaves unalerted', () => {
    // The cache and pool metrics exist but have no rule. The diagnostician has
    // to be able to reach them, or "write this rule" findings are impossible.
    const queries = STANDARD_QUERIES.map((q) => q.query).join(' ');
    expect(queries).toContain('catalog_cache_lookups_total');
    expect(queries).toContain('db_pool_connections');
  });
});
