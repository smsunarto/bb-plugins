import type { BranchAction } from "../shared/schema.ts";

/**
 * Each branch-card button as `but` argv. Branches are named, not given by CLI
 * id, because ids are reassigned on every `but` invocation.
 */
export function actionArgs(action: BranchAction): string[] {
  switch (action.kind) {
    case "push":
      return ["push", action.branch, ...(action.force ? ["--with-force"] : [])];
    case "createReview": {
      // `but pr new -m` reads the first line as the title, the rest as the body.
      const body = action.body.trim();
      const message = body === "" ? action.title : `${action.title}\n\n${body}`;
      // `--draft` belongs to `but pr`, not `new`, in the CLI this was built against.
      return ["pr", ...(action.draft ? ["--draft"] : []), "new", action.branch, "-m", message];
    }
    case "land":
      // The panel asks before it calls this, so the CLI's own prompt is skipped.
      return ["land", action.branch, "--yes"];
    case "rename":
      return ["reword", action.branch, "-m", action.name];
  }
}
