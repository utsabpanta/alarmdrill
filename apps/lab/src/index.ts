/**
 * The demo system alarmdrill runs against: gateway → checkout → payments →
 * psp-mock, plus catalog, Postgres, Redis, Toxiproxy, Prometheus and
 * Alertmanager.
 *
 * Its alert rules are deliberately incomplete. Every planted gap is documented
 * in ./README.md and asserted by ./src/planted-gaps.test.ts — a gap that is not
 * written down is a bug in the lab, not a finding about the tool.
 */
export { loadConfig, SERVICE_NAMES, type LabConfig, type ServiceName } from './config.js';
export { startService, type ServiceDefinition } from './http.js';
export { startLoadGenerator } from './loadgen.js';
export { lookupProduct, type CatalogPorts, type Product } from './services/catalog-lookup.js';
export { createCatalogService } from './services/catalog.js';
export { createCheckoutService } from './services/checkout.js';
export { createGatewayService } from './services/gateway.js';
export { createPaymentsService } from './services/payments.js';
export { createPspMockService } from './services/psp-mock.js';
