export { injectionError, revertError } from './errors.js';
export { createFileJournal, buildEntry, type Journal, type JournalDeps } from './journal.js';
export {
  assertTargetAllowed,
  PRODUCTION_PATTERNS,
  type TargetPolicy,
} from './safety.js';
export {
  createInjectionSession,
  DEFAULT_MAX_DURATION_MS,
  type ActiveInjection,
  type InjectionSession,
  type InjectOptions,
  type SessionDeps,
  type SweepResult,
} from './session.js';
export {
  createToxiproxyClient,
  type Proxy,
  type Toxic,
  type ToxiproxyClient,
  type ToxiproxyDeps,
} from './toxiproxy.js';
export { createDockerControl, listLabTargets } from './docker.js';
export {
  createLatencyInjector,
  LATENCY_KIND,
  type LatencyConfig,
} from './faults/latency.js';
export {
  createStopContainerInjector,
  STOP_CONTAINER_KIND,
  type ContainerControl,
  type StopContainerConfig,
} from './faults/stop-container.js';
export {
  createDeclineRateInjector,
  DECLINE_RATE_KIND,
  type DeclineRateConfig,
} from './faults/decline-rate.js';
export {
  journalEntrySchema,
  revertPlanSchema,
  type Injector,
  type JournalEntry,
  type RevertPlan,
} from './types.js';
export { installSignalCleanup, type SignalCleanupDeps, type SignalName } from './signals.js';
