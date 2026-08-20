import type { CacheLookupResult } from '../metrics.js';

export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

export interface CatalogPorts {
  cacheGet(id: string): Promise<Product | null>;
  cacheSet(id: string, product: Product): Promise<void>;
  dbGet(id: string): Promise<Product | null>;
  recordLookup(result: CacheLookupResult): void;
}

/**
 * The flagship blind spot, in eight lines.
 *
 * When Redis is gone, every lookup falls through to Postgres and returns a
 * correct 200. Nothing errors, latency moves a little but stays well under the
 * gateway alert threshold, and the only signal that anything changed is
 * `catalog_cache_lookups_total{result="error"}` — which no alert rule reads.
 *
 * This is deliberate. Do not add error propagation here to "improve" the lab.
 */
export async function lookupProduct(ports: CatalogPorts, id: string): Promise<Product | null> {
  try {
    const cached = await ports.cacheGet(id);
    if (cached !== null) {
      ports.recordLookup('hit');
      return cached;
    }
    ports.recordLookup('miss');
  } catch {
    // Cache is unreachable. Degrade silently to the database — exactly the
    // behaviour a well-meaning team ships, and exactly why it goes unnoticed.
    ports.recordLookup('error');
  }

  const product = await ports.dbGet(id);
  if (product === null) return null;

  try {
    await ports.cacheSet(id, product);
  } catch {
    // Best effort. A write-through failure must never fail the request.
  }
  return product;
}
