import { describe, expect, it } from 'vitest';
import type { ToxiproxyClient } from '../toxiproxy.js';
import { createDeclineRateInjector } from './decline-rate.js';
import { createLatencyInjector } from './latency.js';
import { createStopContainerInjector, type ContainerControl } from './stop-container.js';

describe('latency injector', () => {
  const calls: string[] = [];
  const client: ToxiproxyClient = {
    getProxy: () => Promise.reject(new Error('unused')),
    addToxic: (proxy, toxic) => {
      calls.push(`add:${proxy}:${toxic.name}:${String(toxic.attributes['latency'])}`);
      return Promise.resolve();
    },
    removeToxic: (proxy, name) => {
      calls.push(`remove:${proxy}:${name}`);
      return Promise.resolve();
    },
  };

  it('plans a revert that needs nothing from the running system', async () => {
    const injector = createLatencyInjector(client);
    const plan = await injector.plan({ proxy: 'checkout-to-payments', latencyMs: 800 });

    // Fully determined before anything is touched — that is what makes
    // journal-before-inject possible.
    expect(plan).toEqual({
      kind: 'toxiproxy.latency',
      target: 'checkout-to-payments',
      data: {
        proxy: 'checkout-to-payments',
        toxicName: 'alarmdrill-latency-checkout-to-payments',
      },
    });
  });

  it('applies and reverts the same namespaced toxic', async () => {
    calls.length = 0;
    const injector = createLatencyInjector(client);
    const plan = await injector.plan({ proxy: 'checkout-to-payments', latencyMs: 800 });
    await injector.apply({ proxy: 'checkout-to-payments', latencyMs: 800 });
    await injector.revert(plan);

    expect(calls).toEqual([
      'add:checkout-to-payments:alarmdrill-latency-checkout-to-payments:800',
      'remove:checkout-to-payments:alarmdrill-latency-checkout-to-payments',
    ]);
  });

  it('rejects a journalled plan whose data is malformed', async () => {
    const injector = createLatencyInjector(client);
    await expect(
      injector.revert({ kind: 'toxiproxy.latency', target: 'p', data: { proxy: 5 } }),
    ).rejects.toThrow();
  });
});

describe('stop-container injector', () => {
  function fakeDocker(initiallyRunning: boolean): ContainerControl & { running: boolean } {
    const state = {
      running: initiallyRunning,
      isRunning: () => Promise.resolve(state.running),
      stop: () => {
        state.running = false;
        return Promise.resolve();
      },
      start: () => {
        state.running = true;
        return Promise.resolve();
      },
    };
    return state;
  }

  it('stops a running container and starts it again on revert', async () => {
    const docker = fakeDocker(true);
    const injector = createStopContainerInjector(docker);

    const plan = await injector.plan({ container: 'alarmdrill-lab-payments' });
    await injector.apply({ container: 'alarmdrill-lab-payments' });
    expect(docker.running).toBe(false);

    await injector.revert(plan);
    expect(docker.running).toBe(true);
  });

  it('is idempotent — reverting an already-running container does nothing', async () => {
    const docker = fakeDocker(true);
    const injector = createStopContainerInjector(docker);
    const plan = await injector.plan({ container: 'c' });

    await injector.revert(plan);
    await injector.revert(plan);
    expect(docker.running).toBe(true);
  });

  // Otherwise "revert" would start a container the operator had deliberately
  // stopped, which is a change we were never asked to make.
  it('refuses to stop a container that is already stopped', async () => {
    const injector = createStopContainerInjector(fakeDocker(false));
    await expect(injector.plan({ container: 'c' })).rejects.toThrow(/not running/);
  });
});

describe('decline-rate injector', () => {
  function fakeControl(initial: number): {
    fetch: typeof globalThis.fetch;
    rate: () => number;
  } {
    let rate = initial;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = typeof init.body === 'string' ? init.body : '{}';
        rate = (JSON.parse(body) as { declineRate: number }).declineRate;
        return Promise.resolve(Response.json({ declineRate: rate }));
      }
      return Promise.resolve(Response.json({ declineRate: rate }));
    }) as typeof globalThis.fetch;
    return { fetch: fetchImpl, rate: () => rate };
  }

  const config = {
    controlUrl: 'http://localhost:3003/_control/decline-rate',
    target: 'alarmdrill-lab-psp-mock',
    declineRate: 0.6,
  };

  // This injector is the one that MUST read before planning: the value to
  // restore exists only in the running service.
  it('captures the previous rate in the plan before changing anything', async () => {
    const control = fakeControl(0.02);
    const injector = createDeclineRateInjector(control.fetch);

    const plan = await injector.plan(config);
    expect(plan.data['previousRate']).toBe(0.02);
    expect(control.rate()).toBe(0.02); // plan() must not mutate

    await injector.apply(config);
    expect(control.rate()).toBe(0.6);

    await injector.revert(plan);
    expect(control.rate()).toBe(0.02);
  });

  it('is idempotent — a second revert restores the same value', async () => {
    const control = fakeControl(0.02);
    const injector = createDeclineRateInjector(control.fetch);
    const plan = await injector.plan(config);
    await injector.apply(config);

    await injector.revert(plan);
    await injector.revert(plan);
    expect(control.rate()).toBe(0.02);
  });

  it('refuses a control response whose shape it does not recognise', async () => {
    const bad = (() => Promise.resolve(Response.json({ rate: 'high' }))) as typeof globalThis.fetch;
    await expect(createDeclineRateInjector(bad).plan(config)).rejects.toThrow(/unexpected shape/);
  });
});
