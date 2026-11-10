/**
 * The review page module, loaded on first open from the plugin's own HTTP
 * route (`scripts/build-page.ts` bundles it) so the eager app bundle stays
 * small. `app.tsx` registers thin shims that import this and render these.
 */
import { ChangesList } from "./changes-nav.tsx";
import { ReviewPage } from "./review-page.tsx";

/** The nav panel's sidebar: the Changes nav. */
export function ChangesSidebar({ subPath }: { subPath: string }) {
  return <ChangesList subPath={subPath} variant="nav" />;
}

export { ReviewPage };
