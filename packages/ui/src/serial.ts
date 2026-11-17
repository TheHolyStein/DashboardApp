/**
 * Wraps an async function so calls run one after another: a call made while another is running waits for it,
 * and every call returns its own promise with its own result or rejection. A rejected call does not block the
 * ones queued behind it. Use it for handlers that read-modify-write a list (avoids lost updates).
 */
export function serial<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A): Promise<R> => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => undefined);
    return run;
  };
}
