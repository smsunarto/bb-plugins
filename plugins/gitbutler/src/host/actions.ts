import type { BranchAction } from "../shared/schema.ts";

/**
 * Each branch-card button as `but` argv. Branches are named, not given by CLI
 * id, because ids are reassigned on every `but` invocation.
 */
export function actionArgs(action: BranchAction): string[] {
  switch (action.kind) {
    case "push":
      return ["push", action.branch, ...(action.force ? ["--with-force"] : [])];
    case "land":
      // The panel asks before it calls this, so the CLI's own prompt is skipped.
      return ["land", action.branch, "--yes"];
    case "rename":
      return ["reword", action.branch, "-m", action.name];
  }
}
