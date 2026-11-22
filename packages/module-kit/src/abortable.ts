import { DashError } from '@dash/contract';

/**
 * Races `p` against `signal`: settles like `p`, or rejects with DashError('upstream', 'aborted')
 * as soon as the signal aborts (immediately if it already has). Wrap awaited host calls in jobs with it.
 */
export function abortable<T>(signal: AbortSignal, p: Promise<T>): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new DashError('upstream', 'aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DashError('upstream', 'aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- forward p's rejection unchanged
        reject(e);
      },
    );
  });
}
