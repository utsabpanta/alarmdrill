import { loadConfig, type ServiceName } from './config.js';
import { startService, type ServiceDefinition } from './http.js';
import { startLoadGenerator } from './loadgen.js';
import { createCatalogService } from './services/catalog.js';
import { createCheckoutService } from './services/checkout.js';
import { createGatewayService } from './services/gateway.js';
import { createPaymentsService } from './services/payments.js';
import { createPspMockService } from './services/psp-mock.js';

const SERVICES: Record<Exclude<ServiceName, 'loadgen'>, () => ServiceDefinition> = {
  gateway: createGatewayService,
  checkout: createCheckoutService,
  payments: createPaymentsService,
  'psp-mock': createPspMockService,
  catalog: createCatalogService,
};

const config = loadConfig();

const stop =
  config.SERVICE === 'loadgen'
    ? startLoadGenerator(config)
    : await startService(SERVICES[config.SERVICE](), config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
