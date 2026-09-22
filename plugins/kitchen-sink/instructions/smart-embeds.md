Use Smart Code to cite current project files. Place this leaf directive on its own line: ::smart-code{path="relative/path.ts" start="12" end="28"}

Unity .unity and .prefab citations render an object inspector with current property values. Omit the line range to show the asset's properties, or provide a range to select properties.

Never embed a diff of the changes you made in this turn. Last Turn renders every recorded change below your final response, so a smart-diff of your own work duplicates it. Describe what you changed in prose.

Use ::smart-diff only when the user asked a question and the answer cites an existing change, such as explaining what a commit did or why history looks the way it does. Cite that commit as ::smart-diff{path="relative/path.ts" source="commit" sha="FULL_40_CHARACTER_SHA"} with the full 40-character SHA, never a short hash, branch name, or GitButler change ID. Do not use the bare form or source="workspace"; the bare form depends on a recorded turn patch that usually does not exist, and the workspace form mixes in other agents' changes.

To show a change before you apply it, save the exact unified diff under thread storage and use ::smart-patch{file="changes.patch" path="relative/path.ts"}. Keep the patch available. Patch embeds display evidence without applying it. Omit path to show all files; select a path before ranging a multi-file patch. Both diff directives accept optional start/end new-side line ranges.

If a diff embed reports a missing source, replace it with a verified exact commit or saved patch, or drop it. Do not repeat the directive or broaden it to source="workspace".

Citations and workspace diffs resolve in the containing thread's workspace. Add workspace="<project>" to target another workspace: a project name or id, an env_ id, or a thr_ id. It does not apply to turn diffs or patches.

Use worktree-relative paths. Do not put directives in inline code or fenced code blocks. Add at most three citations, and only for material files or claims.

## Before/after images

Use ::smart-image-compare{before=".scratch/before.png" after=".scratch/after.png" beforeLabel="Original" afterLabel="Updated"} on its own line to compare two images with a draggable divider. The left side reveals `before`, the right reveals `after`. Readers can drag the handle or focus it and use arrow keys. Labels are optional and default to Before and After. Supply descriptive labels as plain text, not text baked into the images.

Prepare the images before emitting the directive:

- Both images must have the exact same pixel width and height, aspect ratio, crop, and scale. For UI screenshots, use the same viewport size, device pixel ratio, zoom, scroll position, and framing.
- Align unchanged landmarks or the subject at the same pixel coordinates. The slider overlays the images and clips each side at the divider. It does not register, align, resize one image to match the other, or correct perspective. Matching dimensions alone does not establish alignment.
- For photos or renders, match camera position, perspective, and subject placement. Crop or pad both to a common canvas without stretching. If they cannot be aligned honestly, show them separately instead.
- Inspect both images and verify dimensions before embedding. Use full images without baked-in side labels, borders, or different margins. The viewer preserves the full image with contain sizing and warns if dimensions differ.

`before` and `after` accept workspace-relative paths or HTTP(S) image URLs. For local generated artifacts, keep both files in place. Add source="thread-storage" when both local paths are relative to the owning thread's storage directory. Do not use absolute filesystem paths. Paths with spaces are allowed inside quoted attributes. The directive must be outside code fences to render.

Side labels render as overlays in the image's upper corners. Keep them short so they do not cover the subject.

To annotate details, add an `annotations` attribute containing a JSON array. Use single quotes around the attribute and double quotes for JSON strings:
::smart-image-compare{before=".scratch/before.png" after=".scratch/after.png" beforeLabel="Original" afterLabel="Updated" annotations='[{"x":72,"y":38,"label":"Background removed","side":"after"}]'}

Each annotation has `x` and `y` percentages from 0 to 100, measured from the image's top-left corner, and a plain-text `label` (up to 500 characters). Convert image pixels with x = pixelX / imageWidth * 100 and y = pixelY / imageHeight * 100. `side` is `before`, `after`, or `both` (default). At most 50 unique callouts are accepted. Prefer a few precise callouts, keep pins away from image edges and the label overlays, and verify they point at the intended feature. Readers click or keyboard-activate numbered pins to read the callout. Pins stay attached to their image and are clipped by the comparison divider. Opened callout text appears in an unclipped overlay at the bottom of the image. These are agent-authored callouts, not a drawing or feedback editor. Do not bake annotations into either image.
