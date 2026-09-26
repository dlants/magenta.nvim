export function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Wait `ms`, or less if `abortSignal` fires first. Resolves with whether the
 * wait completed: an abort is a value, not a rejection. */
export function abortableDelay(
  ms: number,
  abortSignal: AbortSignal,
): Promise<"elapsed" | "aborted"> {
  if (abortSignal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Defer<T> {
  public promise: Promise<T>;
  public resolve: (val: T) => void;
  public reject: (err: Error) => void;
  public resolved: boolean = false;

  constructor() {
    let resolve: typeof this.resolve;
    let reject: typeof this.reject;

    this.resolve = (val) => {
      if (resolve !== undefined) {
        resolve(val);
      }
      this.resolved = true;
    };

    this.reject = (err) => {
      if (reject !== undefined) {
        reject(err);
      }
      this.resolved = true;
    };

    this.promise = new Promise((fnRes, fnRej) => {
      resolve = fnRes;
      reject = fnRej;
    });
  }
}

/** Await work that has no way to be cancelled, but no longer than the abortSignal.
 * Resolves `undefined` if the abortSignal fires first: the work is abandoned, not
 * cancelled, so this is only sound where its effects are applied by the
 * caller and dropping the result drops them. What it buys is a bounded wait
 * for whoever needs the awaiting body to unwind. */
export function untilAborted<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal,
): Promise<T | undefined> {
  if (abortSignal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    abortSignal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** poll fn until it returns.
 */
export async function pollUntil<T>(
  fn: (() => Promise<T>) | (() => T),
  opts: { timeout: number; message?: string } = { timeout: 1000 },
): Promise<T> {
  const start = Date.now();
  let lastError: Error | undefined;
  while (true) {
    if (Date.now() - start > opts.timeout) {
      if (opts.message) {
        throw new Error(opts.message);
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error(`pollUntil timeout`);
    }

    try {
      const res = fn();
      const val = res && (res as Promise<unknown>).then ? await res : res;
      return val;
    } catch (e) {
      lastError = e as Error;
    }

    await delay(100);
  }
}

/**
 * Wrap a promise with a timeout. If the promise resolves/rejects before the timeout,
 * return its result. Otherwise, reject with a timeout error.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              message ? message : `Promise timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
    }),
  ]);
}
