import { describe, expect, it } from 'vitest';
import type { CacheLookupResult } from '../metrics.js';
import { lookupProduct, type CatalogPorts, type Product } from './catalog-lookup.js';

const PRODUCT: Product = { id: 'p1', name: 'Widget', priceCents: 1_299 };

function createPorts(overrides: Partial<CatalogPorts> = {}): {
  ports: CatalogPorts;
  recorded: CacheLookupResult[];
} {
  const recorded: CacheLookupResult[] = [];
  const ports: CatalogPorts = {
    cacheGet: () => Promise.resolve(null),
    cacheSet: () => Promise.resolve(),
    dbGet: () => Promise.resolve(PRODUCT),
    recordLookup: (result) => recorded.push(result),
    ...overrides,
  };
  return { ports, recorded };
}

describe('lookupProduct', () => {
  it('serves from cache on a hit without touching the database', async () => {
    let dbCalls = 0;
    const { ports, recorded } = createPorts({
      cacheGet: () => Promise.resolve(PRODUCT),
      dbGet: () => {
        dbCalls += 1;
        return Promise.resolve(PRODUCT);
      },
    });

    await expect(lookupProduct(ports, 'p1')).resolves.toEqual(PRODUCT);
    expect(dbCalls).toBe(0);
    expect(recorded).toEqual(['hit']);
  });

  it('falls back to the database on a miss and repopulates the cache', async () => {
    const written: string[] = [];
    const { ports, recorded } = createPorts({
      cacheSet: (id) => {
        written.push(id);
        return Promise.resolve();
      },
    });

    await expect(lookupProduct(ports, 'p1')).resolves.toEqual(PRODUCT);
    expect(recorded).toEqual(['miss']);
    expect(written).toEqual(['p1']);
  });

  // This is the planted blind spot. If this test ever starts failing because
  // the lookup now throws or returns an error status, the lab has stopped
  // demonstrating the thing alarmdrill exists to find.
  it('still returns the product when the cache is unreachable', async () => {
    const { ports, recorded } = createPorts({
      cacheGet: () => Promise.reject(new Error('ECONNREFUSED')),
      cacheSet: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(lookupProduct(ports, 'p1')).resolves.toEqual(PRODUCT);
    expect(recorded).toEqual(['error']);
  });

  it('reports a missing product as null rather than an error', async () => {
    const { ports } = createPorts({ dbGet: () => Promise.resolve(null) });
    await expect(lookupProduct(ports, 'nope')).resolves.toBeNull();
  });
});
