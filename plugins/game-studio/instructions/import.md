Use `scott-engineering:game-dev` to inspect the files staged in `canvas/staging`.
When the request identifies an asset, scope the import to that selected file.
Read its generation receipt when supplied to recover the brief and references.
The receipt describes the recorded output; it does not verify the current file's
bytes or establish visual acceptance. Inspect the actual file and account for
changes before relying on an earlier review. Uploaded assets can lack a receipt;
do not invent one. Selecting a file prepares a review request, not an approval.
Verify each selected output against its asset contract before importing it into
Unity. Discover and acquire the main Editor's authoring claim with
`unity-editors` before shared Assets/Packages writes. Preserve existing prefab
GUIDs, gameplay bindings, serialized references, rigs, and animation event names.
Import into the project's established asset structure and configure the actual
Unity importer, scale, pivot, materials, audio, or sprite settings as needed.
Validate in the consumer scene/prefab using the existing game driver. Keep
staging sources and generation receipts. Update the canvas and asset catalog
with the imported Assets-relative path only after successful verification. Wait
for native work and tracked Pipeline jobs to finish before releasing ownership.
