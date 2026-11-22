import type { LoggerLike } from './modules/deps.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface DeferredLogger extends LoggerLike {
  /** Routes everything (including loggers already handed out via `child`) to `target` from now on. */
  attach(target: LoggerLike): void;
}

/**
 * The module host needs a logger before the Fastify app (and its pino logger) exists. Until `attach` is
 * called, records go to `fallback` as JSON lines on stderr (none when `fallback` is false); afterwards they
 * go to the app logger, whose redaction rules then apply. Only module ids and reasons are logged this early.
 */
export function createDeferredLogger(fallback: boolean): DeferredLogger {
  let target: LoggerLike | undefined;
  const make = (bindings: Record<string, unknown>): LoggerLike => {
    const emit =
      (level: Level) =>
      (obj: object, msg?: string): void => {
        if (target) {
          target.child(bindings)[level](obj, msg);
        } else if (fallback) {
          process.stderr.write(`${JSON.stringify({ level, time: Date.now(), ...bindings, ...obj, msg })}\n`);
        }
      };
    return {
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  };
  return {
    ...make({}),
    attach: (t) => {
      target = t;
    },
  };
}
