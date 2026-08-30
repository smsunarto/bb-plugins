export class RepositoryMutationQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(
    canonicalRepositoryPath: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(canonicalRepositoryPath) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(canonicalRepositoryPath, tail);

    try {
      await previous.catch(() => undefined);
      if (signal.aborted) throw signal.reason;
      return await operation();
    } finally {
      release?.();
      if (this.#tails.get(canonicalRepositoryPath) === tail) {
        this.#tails.delete(canonicalRepositoryPath);
      }
    }
  }
}
