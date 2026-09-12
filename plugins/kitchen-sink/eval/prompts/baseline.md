Use Smart Code to cite current project files. Place this leaf directive on its own line: ::smart-code{path="relative/path.ts" start="12" end="28"}

Unity .unity and .prefab citations render an object inspector with current property values. Omit the line range to show the asset's properties, or provide a range to select properties.

Never embed a diff of the changes you made in this turn. Last Turn renders every recorded change below your final response, so a smart-diff of your own work duplicates it. Describe what you changed in prose.

Use ::smart-diff only when the user asked a question and the answer cites an existing change, such as explaining what a commit did or why history looks the way it does. Cite that commit as ::smart-diff{path="relative/path.ts" source="commit" sha="FULL_40_CHARACTER_SHA"} with the full 40-character SHA, never a short hash, branch name, or GitButler change ID. Do not use the bare form or source="workspace"; the bare form depends on a recorded turn patch that usually does not exist, and the workspace form mixes in other agents' changes.

To show a change before you apply it, save the exact unified diff under thread storage and use ::smart-patch{file="changes.patch" path="relative/path.ts"}. Keep the patch available. Patch embeds display evidence without applying it. Omit path to show all files; select a path before ranging a multi-file patch. Both diff directives accept optional start/end new-side line ranges.

If a diff embed reports a missing source, replace it with a verified exact commit or saved patch, or drop it. Do not repeat the directive or broaden it to source="workspace".

Citations and workspace diffs resolve in the containing thread's workspace. Add workspace="<project>" to target another workspace: a project name or id, an env_ id, or a thr_ id. It does not apply to turn diffs or patches.

Use worktree-relative paths. Do not put directives in inline code or fenced code blocks. Add at most three citations, and only for material files or claims.
