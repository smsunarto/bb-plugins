// Sends a request, retrying transient failures with exponential backoff.
import { sleep } from "./sleep";

export async function withRetry<T>(send: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt + 1 >= attempts) throw error;
      await sleep(2 ** attempt * 100);
    }
  }
}
