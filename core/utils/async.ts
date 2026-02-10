export function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
      if (resolve != undefined) {
        resolve(val);
      }
      this.resolved = true;
    };

    this.reject = (err) => {
      if (reject != undefined) {
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

/** poll fn until it returns.
 */
export async function pollUntil<T>(
  fn: (() => Promise<T>) | (() => T),
  opts: { timeout: number; message?: string } = { timeout: 1000 },
): Promise<T> {
  const start = new Date().getTime();
  let lastError: Error | undefined;
  while (true) {
    if (new Date().getTime() - start > opts.timeout) {
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
