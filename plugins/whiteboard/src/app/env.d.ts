/** Side-effect stylesheet imports; `bb plugin build` bundles them. */
declare module "*.css";

/** Vite's dev-client hook, read optionally by vendored `review-document-error-report.ts`. Always undefined in bb. */
interface ImportMeta {
  readonly hot?: { send(event: string, data?: unknown): void };
}
