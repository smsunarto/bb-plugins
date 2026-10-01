// Vendored from dev.fast review/app/src/review-definition-test-utils.ts @4ecc570 (MIT).
import {
  type CodePeekProps,
  createReviewDefinitionSession,
} from "../../../../../shared/vendor/review/src/authoring.ts";
import { defineSoftwareModel } from "./software-map/model.ts";

export function createTestReviewDefinitionSession(
  options: {
    softwareMap?: ReturnType<typeof defineSoftwareModel>;
    validateCodePeek?: (props: CodePeekProps) => Promise<void>;
  } = {},
) {
  const softwareMap =
    options.softwareMap ?? defineSoftwareModel({ systems: {} });

  return createReviewDefinitionSession({
    softwareMap,
    baseSoftwareMap: softwareMap,
    validateCodePeek: options.validateCodePeek ?? (async () => {}),
  });
}
