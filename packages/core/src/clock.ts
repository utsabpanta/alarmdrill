/**
 * All time flows through this interface. Nothing in the codebase may call
 * `Date.now()`, `new Date()` or `setTimeout` directly — detection latency is a
 * measured output here, and no test may depend on wall-clock timing
 * (SPEC.md, "Decisions already made").
 */
export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Schedules `fn`; the returned function cancels it and is idempotent. */
  setTimer(ms: number, fn: () => void): CancelTimer;
}

export type CancelTimer = () => void;

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  setTimer: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface FakeClock extends Clock {
  /**
   * Moves time forward, firing every timer due at or before the new instant.
   * Timers scheduled by a firing callback are picked up in the same advance.
   */
  advance(ms: number): Promise<void>;
  /** Timers still scheduled. Useful for leak assertions. */
  pendingTimers(): number;
}

interface ScheduledTimer {
  readonly at: number;
  readonly fn: () => void;
}

/** Manually advanced clock for tests. Timers fire in chronological order. */
export function createFakeClock(start: Date | number = 0): FakeClock {
  let nowMs = typeof start === 'number' ? start : start.getTime();
  let nextId = 1;
  const timers = new Map<number, ScheduledTimer>();

  const setTimer = (ms: number, fn: () => void): CancelTimer => {
    const id = nextId++;
    timers.set(id, { at: nowMs + ms, fn });
    return () => {
      timers.delete(id);
    };
  };

  return {
    now: () => new Date(nowMs),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimer(ms, resolve);
      }),
    setTimer,
    pendingTimers: () => timers.size,
    advance: async (ms) => {
      const target = nowMs + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (next === undefined) break;

        const [id, timer] = next;
        timers.delete(id);
        nowMs = Math.max(nowMs, timer.at);
        timer.fn();
        await flushMicrotasks();
      }
      nowMs = target;
      await flushMicrotasks();
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
