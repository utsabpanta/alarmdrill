import { z } from 'zod';
import { injectionError, revertError } from '../errors.js';
import { revertPlanSchema, type Injector, type RevertPlan } from '../types.js';

export const STOP_CONTAINER_KIND = 'docker.stop';

export interface StopContainerConfig {
  readonly container: string;
}

const stopDataSchema = z.object({ container: z.string() });

/**
 * Narrow slice of dockerode we actually use, so tests can supply a fake without
 * standing up a daemon.
 */
export interface ContainerControl {
  readonly stop: (name: string) => Promise<void>;
  readonly start: (name: string) => Promise<void>;
  readonly isRunning: (name: string) => Promise<boolean>;
}

export function createStopContainerInjector(docker: ContainerControl): Injector<StopContainerConfig> {
  return {
    kind: STOP_CONTAINER_KIND,
    targetOf: (config) => config.container,

    plan: async (config) => {
      // Refuse to stop something that is already down: we would "revert" by
      // starting a container the operator had deliberately stopped.
      if (!(await docker.isRunning(config.container))) {
        throw injectionError(
          `container "${config.container}" is not running, so stopping it would prove nothing`,
        );
      }
      const plan: RevertPlan = {
        kind: STOP_CONTAINER_KIND,
        target: config.container,
        data: { container: config.container },
      };
      return revertPlanSchema.parse(plan);
    },

    apply: async (config) => {
      await docker.stop(config.container);
    },

    revert: async (plan) => {
      const data = stopDataSchema.parse(plan.data);
      // Idempotent: already running is the state we wanted.
      if (await docker.isRunning(data.container)) return;
      try {
        await docker.start(data.container);
      } catch (cause: unknown) {
        throw revertError(`failed to restart container "${data.container}"`, { cause });
      }
    },
  };
}
