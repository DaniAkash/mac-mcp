export class TimeoutError extends Error {
  constructor(ms: number, label?: string) {
    super(label ? `${label} timed out after ${ms}ms` : `timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout. Throws `TimeoutError` if the timeout fires first.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => rejectFn(new TimeoutError(ms, label)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolveFn(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectFn(e);
      },
    );
  });
}
