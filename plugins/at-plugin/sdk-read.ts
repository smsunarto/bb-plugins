export const SDK_READ_TIMEOUT_MS = 1_500;

export async function boundedSdkRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
  timeoutMs = SDK_READ_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => {
        controller.abort();
        reject(new Error("SDK read cancelled"));
      };
      if (parentSignal?.aborted) return abort();
      parentSignal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("SDK read timed out"));
      }, timeoutMs);
      Promise.resolve()
        .then(() => read(controller.signal))
        .then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) parentSignal?.removeEventListener("abort", abort);
  }
}
