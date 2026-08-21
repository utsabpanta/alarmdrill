import { describe, expect, it } from 'vitest';
import { createFakeClock } from './clock.js';
import { createSilentLogger } from './logger.js';
import { runExperiment, runSuite, type ExperimentPorts } from './run.js';

const NOISY = { fingerprint: 'fp-noise', alertname: 'HighMemoryUsage' };
const NOVEL = { fingerprint: 'fp-down', alertname: 'ServiceDown' };

interface Trace {
  calls: string[];
  reverted: number;
  evidenceWindow?: { from: Date; to: Date };
}

function createPorts(
  trace: Trace,
  behaviour: { injectThrows?: boolean; diagnoseThrows?: boolean } = {},
): ExperimentPorts<{ alerts: typeof NOVEL[] }, { window: string }, { answer: string }, { verdict: string }> {
  return {
    captureBaseline: () => {
      trace.calls.push('captureBaseline');
      return Promise.resolve([NOISY]);
    },
    startWatch: () => {
      trace.calls.push('startWatch');
      return {
        stop: () => {
          trace.calls.push('watch.stop');
          return Promise.resolve([{ alerts: [NOISY, NOVEL] }]);
        },
      };
    },
    inject: () => {
      trace.calls.push('inject');
      if (behaviour.injectThrows === true) return Promise.reject(new Error('injection failed'));
      return Promise.resolve({
        id: 'inj-1',
        revert: () => {
          trace.calls.push('revert');
          trace.reverted += 1;
          return Promise.resolve();
        },
      });
    },
    scoreDetection: ({ baseline, polls }) => {
      trace.calls.push('scoreDetection');
      const baseFps = new Set(baseline.map((a) => a.fingerprint));
      const novel = polls.flatMap((p) => p.alerts).filter((a) => !baseFps.has(a.fingerprint));
      return {
        detected: novel.length > 0,
        timeToDetectMs: novel.length > 0 ? 30_000 : null,
        novel,
        preexisting: [...baseline],
      };
    },
    collectEvidence: (window) => {
      trace.calls.push('collectEvidence');
      trace.evidenceWindow = window;
      return Promise.resolve({ window: window.from.toISOString() });
    },
    diagnose: () => {
      trace.calls.push('diagnose');
      if (behaviour.diagnoseThrows === true) return Promise.reject(new Error('model exploded'));
      return Promise.resolve({ answer: 'redis' });
    },
    grade: () => {
      trace.calls.push('grade');
      return Promise.resolve({ verdict: 'correct' });
    },
  };
}

const deps = () => ({ clock: createFakeClock(new Date('2026-01-01T12:00:00Z')), logger: createSilentLogger() });

describe('runExperiment', () => {
  it('captures the baseline before injecting anything', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const run = runExperiment(createPorts(trace), { id: 'e1', holdMs: 60_000 }, d);
    await d.clock.advance(60_000);
    await run;

    // Without a pre-injection baseline, a chronically-firing alert would make
    // every blind spot look caught.
    expect(trace.calls.indexOf('captureBaseline')).toBeLessThan(trace.calls.indexOf('inject'));
  });

  it('runs the lifecycle in order and reverts before diagnosing', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const run = runExperiment(createPorts(trace), { id: 'e1', holdMs: 60_000 }, d);
    await d.clock.advance(60_000);
    await run;

    expect(trace.calls).toEqual([
      'captureBaseline', 'startWatch', 'inject', 'watch.stop', 'revert',
      'scoreDetection', 'collectEvidence', 'diagnose', 'grade',
    ]);
  });

  it('pads the evidence window back before the injection', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const run = runExperiment(
      createPorts(trace), { id: 'e1', holdMs: 60_000, windowPaddingMs: 120_000 }, d,
    );
    await d.clock.advance(60_000);
    await run;

    // A window starting exactly at injection would tell the diagnostician when
    // the fault began, which is most of a diagnosis.
    expect(trace.evidenceWindow?.from.toISOString()).toBe('2026-01-01T11:58:00.000Z');
  });

  it('reverts even when the diagnosis step throws', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    // Expectation attached before advancing: otherwise the promise rejects
    // while nothing is awaiting it and vitest reports an unhandled rejection.
    const settled = expect(
      runExperiment(createPorts(trace, { diagnoseThrows: true }), { id: 'e1', holdMs: 1_000 }, d),
    ).rejects.toThrow('model exploded');
    await d.clock.advance(1_000);
    await settled;
    expect(trace.reverted).toBe(1);
  });

  it('does not attempt a revert when injection never succeeded', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const settled = expect(
      runExperiment(createPorts(trace, { injectThrows: true }), { id: 'e1', holdMs: 1_000 }, d),
    ).rejects.toThrow('injection failed');
    await d.clock.advance(1_000);
    await settled;

    expect(trace.reverted).toBe(0);
    expect(trace.calls).toContain('watch.stop');
  });

  it('scores a novel alert as detected and keeps the noise separate', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const run = runExperiment(createPorts(trace), { id: 'e1', holdMs: 1_000 }, d);
    await d.clock.advance(1_000);
    const result = await run;

    expect(result.detection.detected).toBe(true);
    expect(result.detection.novel.map((a) => a.alertname)).toEqual(['ServiceDown']);
    expect(result.detection.preexisting.map((a) => a.alertname)).toEqual(['HighMemoryUsage']);
  });
});

describe('runSuite', () => {
  it('runs experiments strictly one at a time', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const experiments = ['a', 'b'].map((id) => ({
      options: { id, holdMs: 1_000 },
      ports: createPorts(trace),
    }));

    const run = runSuite(experiments, { runId: 'r1' }, d);
    await d.clock.advance(10_000);
    const result = await run;

    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
    // Each experiment completes fully before the next begins — two concurrent
    // faults would make every diagnosis ambiguous.
    const firstGrade = trace.calls.indexOf('grade');
    const secondInject = trace.calls.lastIndexOf('inject');
    expect(firstGrade).toBeLessThan(secondInject);
  });

  it('records a failure and carries on by default', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const run = runSuite(
      [
        { options: { id: 'bad', holdMs: 1_000 }, ports: createPorts(trace, { injectThrows: true }) },
        { options: { id: 'good', holdMs: 1_000 }, ports: createPorts(trace) },
      ],
      { runId: 'r1' },
      d,
    );
    await d.clock.advance(10_000);
    const result = await run;

    expect(result.failures.map((f) => f.id)).toEqual(['bad']);
    expect(result.results.map((r) => r.id)).toEqual(['good']);
  });

  it('stops the suite when failFast is set', async () => {
    const trace: Trace = { calls: [], reverted: 0 };
    const d = deps();
    const settled = expect(
      runSuite(
        [
          { options: { id: 'bad', holdMs: 1_000 }, ports: createPorts(trace, { injectThrows: true }) },
          { options: { id: 'never', holdMs: 1_000 }, ports: createPorts(trace) },
        ],
        { runId: 'r1', failFast: true },
        d,
      ),
    ).rejects.toThrow(/experiment bad failed/);
    await d.clock.advance(10_000);
    await settled;
  });
});
