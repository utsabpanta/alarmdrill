import { describe, expect, it } from 'vitest';
import type { ObservedAlert } from './alertmanager.js';
import { scoreDetection, summariseDetection } from './detection.js';

const alert = (name: string, overrides: Partial<ObservedAlert> = {}): ObservedAlert => ({
  fingerprint: `fp-${name}`,
  alertname: name,
  severity: 'warning',
  labels: { alertname: name },
  annotations: {},
  startsAt: '2026-01-01T00:00:00.000Z',
  silenced: false,
  ...overrides,
});

const WINDOW_START = new Date('2026-01-01T12:00:00.000Z');
const at = (secondsIn: number): Date => new Date(WINDOW_START.getTime() + secondsIn * 1_000);

describe('scoreDetection', () => {
  it('measures time to the first novel alert', () => {
    const result = scoreDetection({
      baseline: [],
      windowStart: WINDOW_START,
      polls: [
        { at: at(0), alerts: [] },
        { at: at(20), alerts: [] },
        { at: at(76), alerts: [alert('ServiceDown')] },
      ],
    });

    expect(result.detected).toBe(true);
    expect(result.timeToDetectMs).toBe(76_000);
    expect(result.novel.map((a) => a.alertname)).toEqual(['ServiceDown']);
  });

  /**
   * The single most important test in this package. The lab's memory alert has
   * been firing for weeks. During a harmless blip it is still firing — and
   * scoring that as a detection would mean this tool measures alert volume
   * rather than alert value, and would call every blind spot "caught".
   */
  it('does NOT count an alert that was already firing before the window', () => {
    const noisy = alert('HighMemoryUsage');
    const result = scoreDetection({
      baseline: [noisy],
      windowStart: WINDOW_START,
      polls: [
        { at: at(10), alerts: [noisy] },
        { at: at(60), alerts: [noisy] },
        { at: at(120), alerts: [noisy] },
      ],
    });

    expect(result.detected).toBe(false);
    expect(result.timeToDetectMs).toBeNull();
    expect(result.novel).toEqual([]);
    expect(result.preexisting.map((a) => a.alertname)).toEqual(['HighMemoryUsage']);
  });

  it('still detects a novel alert while noise is firing alongside it', () => {
    const noisy = alert('HighMemoryUsage');
    const result = scoreDetection({
      baseline: [noisy],
      windowStart: WINDOW_START,
      polls: [
        { at: at(10), alerts: [noisy] },
        { at: at(30), alerts: [noisy, alert('ServiceDown')] },
      ],
    });

    expect(result.detected).toBe(true);
    expect(result.timeToDetectMs).toBe(30_000);
    expect(result.novel.map((a) => a.alertname)).toEqual(['ServiceDown']);
  });

  it('ignores a silenced alert, because it reached nobody', () => {
    const result = scoreDetection({
      baseline: [],
      windowStart: WINDOW_START,
      polls: [{ at: at(15), alerts: [alert('ServiceDown', { silenced: true })] }],
    });

    expect(result.detected).toBe(false);
  });

  it('reports the earliest sighting when an alert appears in several polls', () => {
    const down = alert('ServiceDown');
    const result = scoreDetection({
      baseline: [],
      windowStart: WINDOW_START,
      polls: [
        { at: at(25), alerts: [down] },
        { at: at(50), alerts: [down] },
      ],
    });

    expect(result.timeToDetectMs).toBe(25_000);
    expect(result.novel).toHaveLength(1);
  });

  it('reports no detection for an empty timeline', () => {
    const result = scoreDetection({ baseline: [], windowStart: WINDOW_START, polls: [] });
    expect(result).toMatchObject({ detected: false, timeToDetectMs: null, firstDetectedAt: null });
  });
});

describe('summariseDetection', () => {
  const detected = (ms: number) => ({
    detected: true, timeToDetectMs: ms, novel: [], preexisting: [], firstDetectedAt: null,
  });
  const missed = {
    detected: false, timeToDetectMs: null, novel: [], preexisting: [], firstDetectedAt: null,
  };

  it('computes rate and median across a suite', () => {
    const summary = summariseDetection([detected(20_000), detected(60_000), missed, missed]);
    expect(summary).toMatchObject({ total: 4, detected: 2, detectionRate: 0.5 });
    expect(summary.medianTimeToDetectMs).toBe(40_000);
  });

  it('takes the median of detected experiments only, not of zeroes', () => {
    // Counting misses as 0ms would flatter MTTD exactly when the tool has the
    // least to be proud of.
    const summary = summariseDetection([detected(90_000), missed, missed]);
    expect(summary.medianTimeToDetectMs).toBe(90_000);
  });

  it('handles a suite where nothing was detected', () => {
    const summary = summariseDetection([missed, missed]);
    expect(summary).toMatchObject({ detectionRate: 0, medianTimeToDetectMs: null });
  });

  it('handles an empty suite without dividing by zero', () => {
    expect(summariseDetection([])).toMatchObject({ total: 0, detectionRate: 0 });
  });
});
