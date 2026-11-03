/** Whether a rejected wake request is safe to automatically submit again. */
export class WakeRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// Power steps reconcile persisted request IDs, so a rejected call can be retried.
export async function retryableWakeStep<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new WakeRequestError(cause instanceof Error ? cause.message : String(cause), true);
  }
}
