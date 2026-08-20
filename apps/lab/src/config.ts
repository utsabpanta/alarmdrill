import { z } from 'zod';

export const SERVICE_NAMES = [
  'gateway',
  'checkout',
  'payments',
  'psp-mock',
  'catalog',
  'loadgen',
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

/**
 * The environment is an external boundary, so it gets a schema like every other
 * one (CLAUDE.md, hard rule 6). Upstreams default to the Toxiproxy listeners,
 * not the services themselves — every inter-service hop in the lab is
 * proxied so M2 has somewhere to attach a toxic.
 */
const envSchema = z.object({
  SERVICE: z.enum(SERVICE_NAMES),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  CHECKOUT_URL: z.url().default('http://checkout:3001'),
  CATALOG_URL: z.url().default('http://catalog:3004'),
  PAYMENTS_URL: z.url().default('http://toxiproxy:18002'),
  PSP_URL: z.url().default('http://toxiproxy:18003'),
  GATEWAY_URL: z.url().default('http://gateway:3000'),

  REDIS_URL: z.url().default('redis://toxiproxy:18379'),
  DATABASE_URL: z.string().default('postgres://lab:lab@toxiproxy:15432/lab'),

  /** Baseline decline rate. The M2 http-fault injector drives this up. */
  PSP_DECLINE_RATE: z.coerce.number().min(0).max(1).default(0.02),
  /** Requests per second the loadgen aims for, split across endpoints. */
  LOAD_RPS: z.coerce.number().positive().default(10),
  /** Postgres pool size. Small on purpose — saturation is a fault we inject. */
  DB_POOL_SIZE: z.coerce.number().int().positive().default(5),
});

export type LabConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LabConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = z.prettifyError(parsed.error);
    throw new Error(`invalid lab environment:\n${detail}`);
  }
  return parsed.data;
}
