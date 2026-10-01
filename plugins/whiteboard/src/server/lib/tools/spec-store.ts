/**
 * Specs only. The vendored `public-tools.test.ts` and `instructions.test.ts`
 * build `new ReviewStore(":memory:")`, which needs the spec database opener
 * (`sqlite-testing.ts`, WP1). A vendor redirect points their `./store.js`
 * import here, so the opener is installed before any store opens.
 */
import "../sqlite-testing.ts";

export { ReviewStore } from "../vendor/review/src/review-api/store.ts";
