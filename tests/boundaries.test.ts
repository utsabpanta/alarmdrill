import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../', import.meta.url);

const FORBIDDEN_IMPORT = /from\s+['"]([^'"]*injectors[^'"]*)['"]|require\(\s*['"]([^'"]*injectors[^'"]*)['"]/g;

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(pkgDir: string): PackageManifest {
  const path = fileURLToPath(new URL(`packages/${pkgDir}/package.json`, ROOT));
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function sourceFiles(pkgDir: string): string[] {
  const dir = fileURLToPath(new URL(`packages/${pkgDir}/src`, ROOT));
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => `${dir}/${entry}`);
}

/** Walks workspace deps by manifest, so a hop through another package is caught too. */
function transitiveWorkspaceDeps(pkgDir: string, seen = new Set<string>()): Set<string> {
  const manifest = readManifest(pkgDir);
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!dep.startsWith('@alarmdrill/') || seen.has(dep)) continue;
    seen.add(dep);
    transitiveWorkspaceDeps(dep.replace('@alarmdrill/', ''), seen);
  }
  return seen;
}

describe('blinding boundary', () => {
  it('observers declares no dependency on injectors, directly or transitively', () => {
    expect([...transitiveWorkspaceDeps('observers')]).not.toContain('@alarmdrill/injectors');
  });

  it('no observers source file imports anything named injectors', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('observers')) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(FORBIDDEN_IMPORT)) {
        const specifier = match[1] ?? match[2];
        offenders.push(`${file.replace(fileURLToPath(ROOT), '')} → ${specifier ?? '?'}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('checks a package that actually has sources, so the sweep cannot pass vacuously', () => {
    expect(sourceFiles('observers').length).toBeGreaterThan(0);
  });
});
