import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock } from '@alarmdrill/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeModel } from './model.js';
import { replayTrace } from './replay.js';
import { createTraceStore, type RunTrace, type TraceStore } from './trace.js';
import { loadPrompt, CURRENT_PROMPT_VERSIONS } from './prompts.js';

const TRACE: RunTrace = {
  schemaVersion: 1,
  runId: 'run-2026-01-01',
  experimentId: '02-redis-down',
  createdAt: '2026-01-01T12:00:00.000Z',
  promptVersions: { diagnostician: 'v1', grader: 'v1' },
  modelName: 'fake',
  evidence: { schemaVersion: 1, firingAlerts: [] },
  diagnosis: {
    suspectedComponent: 'redis',
    faultCategory: 'dependency_unavailable',
    confidence: 'high',
    reasoning: 'cache errors climbed',
    evidenceCited: ['catalog_cache_lookups_total'],
    missingTelemetry: 'cache error rate alert',
  },
  groundTruth: {
    description: 'redis was stopped',
    expectedComponent: 'redis',
    expectedCategory: 'dependency_unavailable',
  },
  detection: {
    detected: false,
    timeToDetectMs: null,
    novelAlertNames: [],
    preexistingAlertNames: ['HighMemoryUsage'],
  },
  grade: {
    verdict: 'correct',
    votes: [{ verdict: 'correct', reasoning: 'right component' }],
    disagreementRate: 0,
    needsReview: false,
    promptVersion: 'v1',
  },
};

describe('trace store', () => {
  let dir: string;
  let store: TraceStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alarmdrill-traces-'));
    store = createTraceStore({ dir, clock: createFakeClock(0) });
  });

  it('round-trips a trace', async () => {
    await store.write(TRACE);
    const read = await store.read('run-2026-01-01', '02-redis-down');
    expect(read).toEqual(TRACE);
  });

  it('lists a run in experiment order', async () => {
    await store.write({ ...TRACE, experimentId: '02-redis-down' });
    await store.write({ ...TRACE, experimentId: '01-payments-down' });
    const listed = await store.list('run-2026-01-01');
    expect(listed.map((t) => t.experimentId)).toEqual(['01-payments-down', '02-redis-down']);
  });

  it('refuses a trace it cannot parse rather than silently skipping it', async () => {
    await store.write(TRACE);
    await writeFile(join(dir, 'run-2026-01-01', 'broken.json'), '{"schemaVersion":99}', 'utf8');
    await expect(store.list('run-2026-01-01')).rejects.toThrow(/unreadable trace/);
  });

  it('reports a missing run clearly', async () => {
    await expect(store.list('never-happened')).rejects.toThrow(/no traces found/);
  });
});

describe('replay', () => {
  it('re-grades a recorded diagnosis without re-running the experiment', async () => {
    const model = createFakeModel({ responses: [{ verdict: 'partial', reasoning: 'symptom only' }] });
    const result = await replayTrace(TRACE, { model });

    expect(result.regraded.verdict).toBe('partial');
    expect(result.previous.verdict).toBe('correct');
    expect(result.changed).toBe(true);
  });

  it('reports an unchanged verdict as unchanged', async () => {
    const model = createFakeModel({ responses: [{ verdict: 'correct', reasoning: 'right' }] });
    const result = await replayTrace(TRACE, { model });
    expect(result.changed).toBe(false);
  });

  /**
   * A trace holds the evidence AND the ground truth. Replay must therefore
   * never call the diagnostician — doing so would prompt a blinded agent from
   * a file containing the answer. The grader is the only thing it may re-run.
   */
  it('never sends the evidence back to a model', async () => {
    const prompts: string[] = [];
    const model = createFakeModel({
      responses: [{ verdict: 'correct', reasoning: 'right' }],
      onCall: (request) => prompts.push(`${request.system}\n${request.user}`),
    });

    await replayTrace(TRACE, { model });

    for (const prompt of prompts) {
      // Grader prompts, and only grader prompts.
      expect(prompt).toContain('You are grading whether');
      expect(prompt).not.toContain('You are the on-call engineer');
    }
  });
});

describe('prompt versioning', () => {
  it('loads the current version of each prompt', () => {
    expect(loadPrompt('diagnostician').version).toBe(CURRENT_PROMPT_VERSIONS.diagnostician);
    expect(loadPrompt('grader').text).toContain('You are grading whether');
  });

  // Old runs were graded under old prompts, so a version that once existed
  // must keep resolving.
  it('fails loudly for a version that does not exist', () => {
    expect(() => loadPrompt('grader', 'v99')).toThrow(/prompts are versioned files/);
  });
});
