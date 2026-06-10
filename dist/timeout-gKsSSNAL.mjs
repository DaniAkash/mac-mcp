//#region src/utils/timeout.ts
var TimeoutError = class extends Error {
  constructor(ms, label) {
    super(label ? `${label} timed out after ${ms}ms` : `timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
};
/**
 * Race a promise against a timeout. Throws `TimeoutError` if the timeout fires first.
 */
function withTimeout(promise, ms, label) {
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
//#endregion
export { withTimeout as n, TimeoutError as t };
