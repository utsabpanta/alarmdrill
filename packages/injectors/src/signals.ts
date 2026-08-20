import type { Logger } from '@alarmdrill/core';
import type { InjectionSession } from './session.js';

export type SignalName = 'SIGINT' | 'SIGTERM';
const HANDLED: readonly SignalName[] = ['SIGINT', 'SIGTERM'];

export interface SignalCleanupDeps {
  readonly session: InjectionSession;
  readonly logger: Logger;
  /** Injected so tests never actually kill the runner. */
  readonly exit?: (code: number) => void;
  readonly process?: NodeJS.EventEmitter;
}

/**
 * Ctrl-C must not leave the target broken.
 *
 * Reverts everything, then exits non-zero — non-zero because an interrupted
 * drill produced no verdict, and a CI job must not read that as a pass.
 * Returns an uninstall function so tests and long-lived hosts can detach.
 */
export function installSignalCleanup(deps: SignalCleanupDeps): () => void {
  const emitter = deps.process ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let handling = false;

  const handlers = HANDLED.map((signal) => {
    const handler = (): void => {
      // A second Ctrl-C must not start a competing revert.
      if (handling) return;
      handling = true;

      deps.logger.warn({ signal }, 'interrupted, reverting all injections before exit');
      void deps.session
        .revertAll()
        .then(() => {
          exit(130);
        })
        .catch((error: unknown) => {
          deps.logger.error(
            { err: error },
            'revert failed during shutdown — the target may still be broken',
          );
          exit(1);
        });
    };
    emitter.on(signal, handler);
    return { signal, handler } as const;
  });

  return () => {
    for (const { signal, handler } of handlers) {
      emitter.off(signal, handler);
    }
  };
}
