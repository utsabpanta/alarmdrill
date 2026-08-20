import { z } from 'zod';
import { injectionError, revertError } from './errors.js';

/**
 * Toxiproxy's HTTP API. Responses are validated rather than trusted — this is
 * an external boundary, and a silently-changed shape would mean we think a
 * fault was applied when it was not.
 *
 * The proxy object carries a `Logger` field we neither use nor model, so these
 * schemas describe what we depend on and ignore the rest.
 */
const toxicSchema = z.object({
  name: z.string(),
  type: z.string(),
  stream: z.string(),
  toxicity: z.number(),
  attributes: z.record(z.string(), z.unknown()),
});

const proxySchema = z.object({
  name: z.string(),
  listen: z.string(),
  upstream: z.string(),
  enabled: z.boolean(),
  toxics: z.array(toxicSchema),
});

export type Toxic = z.infer<typeof toxicSchema>;
export type Proxy = z.infer<typeof proxySchema>;

export interface ToxiproxyClient {
  readonly getProxy: (name: string) => Promise<Proxy>;
  readonly addToxic: (proxy: string, toxic: Toxic) => Promise<void>;
  /** Resolves when the toxic is gone, including when it was already gone. */
  readonly removeToxic: (proxy: string, toxicName: string) => Promise<void>;
}

export interface ToxiproxyDeps {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createToxiproxyClient(deps: ToxiproxyDeps): ToxiproxyClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const url = `${deps.baseUrl}${path}`;
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause: unknown) {
      throw injectionError(`toxiproxy request failed: ${init.method ?? 'GET'} ${url}`, { cause });
    }
  };

  return {
    getProxy: async (name) => {
      const response = await request(`/proxies/${encodeURIComponent(name)}`);
      if (!response.ok) {
        throw injectionError(`toxiproxy has no proxy "${name}" (HTTP ${String(response.status)})`);
      }
      const parsed = proxySchema.safeParse(await response.json());
      if (!parsed.success) {
        throw injectionError(
          `toxiproxy returned an unexpected proxy shape: ${z.prettifyError(parsed.error)}`,
        );
      }
      return parsed.data;
    },

    addToxic: async (proxy, toxic) => {
      const response = await request(`/proxies/${encodeURIComponent(proxy)}/toxics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toxic),
      });
      if (!response.ok) {
        throw injectionError(
          `toxiproxy refused toxic "${toxic.name}" on "${proxy}" (HTTP ${String(response.status)}): ${await response.text()}`,
        );
      }
    },

    removeToxic: async (proxy, toxicName) => {
      const response = await request(
        `/proxies/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(toxicName)}`,
        { method: 'DELETE' },
      );
      // 204 means we removed it; 404 means it was already gone. Both are the
      // state we wanted, and revert gets called more than once by design.
      if (response.ok || response.status === 404) return;
      throw revertError(
        `failed to remove toxic "${toxicName}" from "${proxy}" (HTTP ${String(response.status)})`,
      );
    },
  };
}
