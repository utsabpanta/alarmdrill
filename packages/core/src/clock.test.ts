import { describe, expect, it } from 'vitest';
import { createFakeClock } from './clock.js';

describe('FakeClock', () => {
  it('only moves when advanced', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');

    await clock.advance(1_500);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.500Z');
  });

  it('resolves sleep at the scheduled instant, not before', async () => {
    const clock = createFakeClock(0);
    let woke = false;
    const sleeping = clock.sleep(1_000).then(() => {
      woke = true;
    });

    await clock.advance(999);
    expect(woke).toBe(false);

    await clock.advance(1);
    await sleeping;
    expect(woke).toBe(true);
  });

  it('fires timers in chronological order', async () => {
    const clock = createFakeClock(0);
    const fired: string[] = [];

    clock.setTimer(300, () => fired.push('c'));
    clock.setTimer(100, () => fired.push('a'));
    clock.setTimer(200, () => fired.push('b'));

    await clock.advance(500);
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  it('runs timers scheduled from within a timer in the same advance', async () => {
    const clock = createFakeClock(0);
    const fired: number[] = [];

    clock.setTimer(100, () => {
      fired.push(clock.now().getTime());
      clock.setTimer(100, () => fired.push(clock.now().getTime()));
    });

    await clock.advance(250);
    expect(fired).toEqual([100, 200]);
  });

  it('cancels idempotently and leaves no pending timers', async () => {
    const clock = createFakeClock(0);
    let fired = false;
    const cancel = clock.setTimer(50, () => {
      fired = true;
    });

    cancel();
    cancel();
    expect(clock.pendingTimers()).toBe(0);

    await clock.advance(1_000);
    expect(fired).toBe(false);
  });
});

describe('FakeClock and pending async work', () => {
  it('fires a timer scheduled by an await chain already in flight', async () => {
    const clock = createFakeClock(0);
    let done = false;

    // advance() is called before sleep() has even been reached. Checking for
    // timers before draining the microtask queue would miss this one and hang.
    const work = (async () => {
      await Promise.resolve();
      await Promise.resolve();
      await clock.sleep(1_000);
      done = true;
    })();

    await clock.advance(1_000);
    await work;
    expect(done).toBe(true);
  });
});
