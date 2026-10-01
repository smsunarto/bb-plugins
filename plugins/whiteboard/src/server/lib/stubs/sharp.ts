/**
 * WP0 interim target for `import("sharp")` in vendored `image-decode.ts`.
 * sharp is native and cannot be bundled (design R6). WP7 replaces the redirect
 * with the `image-decode.ts` edit and deletes this file.
 */
type Sharp = {
  metadata(): Promise<{ format?: string; pages?: number }>;
  png(): { toBuffer(): Promise<Buffer> };
};

export default function sharp(_input: Buffer, _options?: Record<string, unknown>): Sharp {
  throw new Error("whiteboard: sharp not wired");
}
