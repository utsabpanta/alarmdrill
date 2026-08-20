import Docker from 'dockerode';
import { injectionError } from './errors.js';
import type { ContainerControl } from './faults/stop-container.js';

/**
 * dockerode wrapper. We use the Engine API rather than shelling out to the
 * docker CLI, because cleanup has to work when the process is dying and
 * spawning children is the least reliable thing to do at that moment.
 */
export function createDockerControl(docker: Docker = new Docker()): ContainerControl {
  const inspect = async (name: string): Promise<{ Running: boolean } | undefined> => {
    try {
      const info = await docker.getContainer(name).inspect();
      return info.State;
    } catch {
      return undefined;
    }
  };

  return {
    isRunning: async (name) => (await inspect(name))?.Running === true,

    stop: async (name) => {
      try {
        await docker.getContainer(name).stop();
      } catch (cause: unknown) {
        throw injectionError(`failed to stop container "${name}"`, { cause });
      }
    },

    start: async (name) => {
      await docker.getContainer(name).start();
    },
  };
}

/** Container names carrying the lab label, for building an allowlist. */
export async function listLabTargets(docker: Docker = new Docker()): Promise<string[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['alarmdrill.target=lab'] },
  });
  return containers.flatMap((c) => c.Names.map((n) => n.replace(/^\//, '')));
}
