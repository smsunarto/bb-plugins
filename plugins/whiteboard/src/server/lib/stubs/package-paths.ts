/**
 * Upstream `findReviewPackageRoot` for `instructions.ts` (design §2.3 C). The
 * instruction files live in the generated module, served by `embedded-fs.ts`
 * under this virtual root, so no runtime path resolution happens.
 */
export const EMBEDDED_PACKAGE_ROOT = "/whiteboard";

export function findReviewPackageRoot(_moduleUrl?: string): string {
  return EMBEDDED_PACKAGE_ROOT;
}
