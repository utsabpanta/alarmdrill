/**
 * Errors are branded plain `Error` objects built by factory functions — no
 * subclassing. Every package defines its own factories; only the CLI boundary
 * is allowed to translate them into process exit codes (SPEC.md, "Style").
 */
export const ALARMDRILL_ERROR: unique symbol = Symbol.for('alarmdrill.error');

export interface AlarmdrillError<Code extends string = string> extends Error {
  readonly [ALARMDRILL_ERROR]: true;
  /** Stable, machine-readable discriminator. Never reworded once shipped. */
  readonly code: Code;
}

export type ErrorFactory<Code extends string> = (
  message: string,
  options?: ErrorOptions,
) => AlarmdrillError<Code>;

/**
 * Mints a factory for one error code.
 *
 *   const injectionFailed = defineError('ERR_INJECTION');
 *   throw injectionFailed('toxiproxy refused the toxic', { cause });
 */
export function defineError<const Code extends string>(code: Code): ErrorFactory<Code> {
  return (message, options) => {
    const error = new Error(message, options);
    error.name = code;
    return Object.assign(error, { [ALARMDRILL_ERROR]: true as const, code });
  };
}

export function isAlarmdrillError(value: unknown): value is AlarmdrillError {
  return value instanceof Error && ALARMDRILL_ERROR in value;
}

export function hasErrorCode<const Code extends string>(
  value: unknown,
  code: Code,
): value is AlarmdrillError<Code> {
  return isAlarmdrillError(value) && value.code === code;
}

/** A run could not start or continue for reasons internal to orchestration. */
export const runError = defineError('ERR_RUN');

/** A safety guard refused an action. Never widen these to make a test pass. */
export const safetyError = defineError('ERR_SAFETY');

/** Config or external payload failed validation at a boundary. */
export const validationError = defineError('ERR_VALIDATION');
