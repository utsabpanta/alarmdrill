import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasErrorCode } from '@alarmdrill/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadSuite, targetOf } from './suite.js';

const VALID = `
version: 1
name: test
endpoints:
  toxiproxy: http://localhost:8474
  alertmanager: http://localhost:9093
  prometheus: http://localhost:9090
safety:
  allow: [alarmdrill-lab-redis]
experiments:
  - id: redis-down
    description: redis was stopped
    fault:
      kind: docker.stop
      container: alarmdrill-lab-redis
    groundTruth:
      component: redis
      category: dependency_unavailable
`;

let dir: string;
const write = async (name: string, body: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, body, 'utf8');
  return path;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alarmdrill-suite-'));
});

describe('loadSuite', () => {
  it('loads a valid suite and applies defaults', async () => {
    const suite = loadSuite(await write('s.yaml', VALID));
    expect(suite.name).toBe('test');
    expect(suite.defaults.holdMs).toBe(90_000);
    expect(suite.experiments[0]?.groundTruth.undiagnosable).toBe(false);
  });

  /**
   * Caught at load time on purpose. Discovering an unlisted target after three
   * faults have already been applied is a bad moment to find out.
   */
  it('refuses a suite targeting something outside the allowlist', async () => {
    const path = await write('bad.yaml', VALID.replace('allow: [alarmdrill-lab-redis]', 'allow: [something-else]'));
    expect(() => loadSuite(path)).toThrow(/not in safety.allow/);
  });

  it('refuses duplicate experiment ids', async () => {
    const dup = `${VALID}
  - id: redis-down
    description: again
    fault:
      kind: docker.stop
      container: alarmdrill-lab-redis
    groundTruth:
      component: redis
      category: dependency_unavailable
`;
    const path = await write('dup.yaml', dup);
    expect(() => loadSuite(path)).toThrow(/duplicate experiment id/);
  });

  it('refuses an unknown fault kind rather than skipping it', async () => {
    const path = await write('unknown.yaml', VALID.replace('kind: docker.stop', 'kind: docker.nuke'));
    expect(() => loadSuite(path)).toThrow(/invalid suite/);
  });

  it('refuses a decline rate outside 0..1', async () => {
    const bad = VALID.replace(
      `    fault:
      kind: docker.stop
      container: alarmdrill-lab-redis`,
      `    fault:
      kind: http.decline-rate
      controlUrl: http://localhost:3003/_control/decline-rate
      target: alarmdrill-lab-redis
      declineRate: 1.5`,
    );
    const path = await write('rate.yaml', bad);
    expect(() => loadSuite(path)).toThrow(/invalid suite/);
  });

  it('raises a validation error the CLI maps to a usage exit code', async () => {
    const path = await write('bad.yaml', 'version: 2\n');
    try {
      loadSuite(path);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(hasErrorCode(error, 'ERR_VALIDATION')).toBe(true);
    }
  });

  it('reports a missing file clearly', () => {
    expect(() => loadSuite(join(dir, 'nope.yaml'))).toThrow(/cannot read suite file/);
  });

  it('reports malformed yaml as malformed, not as invalid config', async () => {
    const path = await write('broken.yaml', 'version: 1\n  bad indent: [');
    expect(() => loadSuite(path)).toThrow(/not valid YAML or JSON/);
  });

  it('accepts json too', async () => {
    const json = JSON.stringify({
      version: 1, name: 'j',
      endpoints: { toxiproxy: 'http://x:8474', alertmanager: 'http://x:9093', prometheus: 'http://x:9090' },
      safety: { allow: ['c'] },
      experiments: [{
        id: 'e', description: 'd',
        fault: { kind: 'docker.stop', container: 'c' },
        groundTruth: { component: 'c', category: 'dependency_unavailable' },
      }],
    });
    const path = await write('s.json', json);
    expect(loadSuite(path).name).toBe('j');
  });
});

describe('the shipped baseline suite', () => {
  const path = fileURLToPath(new URL('../../../suites/baseline.yaml', import.meta.url));

  it('is valid', () => {
    expect(() => loadSuite(path)).not.toThrow();
  });

  it('drills the blind spots the lab documents', () => {
    const suite = loadSuite(path);
    const ids = suite.experiments.map((e) => e.id);
    expect(ids.some((id) => id.includes('redis'))).toBe(true);
    expect(ids.some((id) => id.includes('psp') || id.includes('decline'))).toBe(true);
    expect(ids.some((id) => id.includes('blip'))).toBe(true);
  });

  it('marks the two undiagnosable faults as such', () => {
    // The declining PSP and the harmless blip both produce no usable signal.
    // Grading a confident guess as correct on those would reward invention.
    const undiagnosable = loadSuite(path)
      .experiments.filter((e) => e.groundTruth.undiagnosable)
      .map((e) => e.id);
    expect(undiagnosable).toHaveLength(2);
  });

  it('keeps every target inside the allowlist', () => {
    const suite = loadSuite(path);
    for (const experiment of suite.experiments) {
      expect(suite.safety.allow).toContain(targetOf(experiment.fault));
    }
  });
});
