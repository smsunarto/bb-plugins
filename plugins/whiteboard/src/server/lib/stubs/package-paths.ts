/**
 * Upstream `findReviewPackageRoot` for `instructions.ts` (design §2.3 C). The
 * virtual root selects BB-authored topic files in `renderInstructions` and
 * unchanged generated topics in `embedded-fs.ts`.
 */
export const EMBEDDED_PACKAGE_ROOT = "/whiteboard";

export function findReviewPackageRoot(_moduleUrl?: string): string {
  return EMBEDDED_PACKAGE_ROOT;
}
