import type { EvidenceBundle } from '@alarmdrill/observers';
import { describe, expect, it } from 'vitest';
import { diagnose, renderEvidence, type Diagnosis } from './diagnostician.js';
import { createFakeModel, type ModelRequest } from './model.js';

const EVIDENCE: EvidenceBundle = {
  schemaVersion: 1,
  window: { from: '2026-01-01T11:55:00.000Z', to: '2026-01-01T12:10:00.000Z' },
  firingAlerts: [
    {
      fingerprint: 'fp1',
      alertname: 'HighMemoryUsage',
      severity: 'warning',
      labels: { alertname: 'HighMemoryUsage', service: 'catalog' },
      annotations: { summary: 'catalog resident memory above 25MB' },
      startsAt: '2026-01-01T09:00:00.000Z',
      silenced: false,
    },
  ],
  metrics: [
    {
      query: 'sum by (result) (rate(catalog_cache_lookups_total[1m]))',
      description: 'catalog cache lookups by outcome',
      series: [
        {
          labels: { result: 'error' },
          samples: [
            { at: '2026-01-01T12:00:00.000Z', value: 0 },
            { at: '2026-01-01T12:05:00.000Z', value: 12.5 },
          ],
        },
      ],
    },
    {
      query: 'payments_charges_total',
      description: 'payment outcomes',
      series: [], // metric does not exist — itself a finding
    },
  ],
  services: ['catalog', 'checkout', 'gateway'],
};

const ANSWER: Diagnosis = {
  suspectedComponent: 'redis',
  faultCategory: 'dependency_unavailable',
  confidence: 'medium',
  reasoning: 'Cache error rate climbed while requests kept succeeding.',
  evidenceCited: ['catalog_cache_lookups_total{result="error"}'],
  missingTelemetry: 'An alert on cache error rate.',
};

describe('renderEvidence', () => {
  /**
   * The blinding guarantee, checked on the exact bytes the model would receive.
   * The object-level test in observers is not enough — rendering is where a
   * leak would actually reach the model.
   */
  it('leaks no injector vocabulary into the prompt', () => {
    const rendered = renderEvidence(EVIDENCE).toLowerCase();
    for (const term of [
      'inject', 'injector', 'injection', 'fault', 'toxic', 'toxiproxy',
      'revert', 'journal', 'deadman', 'experiment', 'ground truth',
      'expected', 'alarmdrill', 'we broke', 'we stopped',
    ]) {
      expect(rendered, `rendered evidence leaked "${term}"`).not.toContain(term);
    }
  });

  it('states plainly when a query returned nothing', () => {
    // "No data" must be legible as a finding. A responder who cannot tell the
    // difference between "flat at zero" and "this metric does not exist"
    // cannot produce the instrument-this-first conclusion.
    expect(renderEvidence(EVIDENCE)).toContain('No data returned.');
  });

  it('summarises a series the way someone reads a graph', () => {
    const rendered = renderEvidence(EVIDENCE);
    expect(rendered).toContain('first=0');
    expect(rendered).toContain('max=12.50');
  });

  it('includes alert names, severities and summaries', () => {
    const rendered = renderEvidence(EVIDENCE);
    expect(rendered).toContain('HighMemoryUsage');
    expect(rendered).toContain('[warning]');
    expect(rendered).toContain('resident memory above 25MB');
  });
});

describe('diagnose', () => {
  it('returns the validated diagnosis and the prompt version used', async () => {
    const model = createFakeModel({ responses: [ANSWER] });
    const result = await diagnose(EVIDENCE, { model });

    expect(result.diagnosis.suspectedComponent).toBe('redis');
    expect(result.promptVersion).toBe('v1');
    expect(model.callCount()).toBe(1);
  });

  it('sends only the rendered evidence and the versioned prompt', async () => {
    const seen: ModelRequest<unknown>[] = [];
    const model = createFakeModel({ responses: [ANSWER], onCall: (r) => seen.push(r) });
    await diagnose(EVIDENCE, { model });

    const [request] = seen;
    expect(request?.system).toContain('You are the on-call engineer');
    // Whole payload, system prompt included — nothing anywhere may name the fault.
    const payload = `${request?.system ?? ''}\n${request?.user ?? ''}`.toLowerCase();
    for (const term of ['toxiproxy', 'injected', 'we stopped', 'ground truth']) {
      expect(payload, `prompt leaked "${term}"`).not.toContain(term);
    }
  });

  it('rejects a model answer that does not match the schema', async () => {
    const model = createFakeModel({ responses: [{ suspectedComponent: 'redis' }] });
    await expect(diagnose(EVIDENCE, { model })).rejects.toThrow();
  });
});
