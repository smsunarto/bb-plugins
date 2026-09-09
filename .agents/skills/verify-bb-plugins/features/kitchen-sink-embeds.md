# Kitchen Sink message embeds

## Sub-features

- Source excerpts through `smart-code` and changed files through `smart-diff`.
- Unity object inspectors for supported `.prefab` and `.unity` diffs.
- Interactive HTML previews through `inline-vis`.

## Fixture and entry

Use a repository-backed thread with an assistant message containing the directives.
Prepare a small HTML file under the thread workspace and a deliberate file change
owned by the run. Record their paths before testing. A user message containing
directive text does not exercise the assistant-message renderer.

```text
::smart-code{path="plugins/last-turn-diff/README.md" start="1" end="7"}
::smart-diff{path="<changed-workspace-file>"}
::inline-vis{file="<workspace-relative-html-file>" height="240"}
```

Replace the example paths with the fixture paths. The source excerpt must show
the requested lines and the diff must show the deliberate change. Expand the
HTML preview if collapsed, then exercise one control inside it.

## Driving and proof

Take a snapshot after the assistant message appears. Use the rendered file
headers and preview toggle. The HTML iframe has title `inline-vis: <file>`.
Capture the message, expanded code/diff, and the result of the HTML interaction.
Save the final thread URL.

For the Unity path, use a text-serialized `.prefab` or `.unity` fixture with a
known base and a deliberate property change. Its smart diff exposes the region
`Unity changes in <path>`. Expand the changed object and verify the property,
then switch **Raw YAML** and **Object view**. Record the fixture prerequisite
when no suitable Unity asset is available.

## Gotchas

- Launch disables the built-in `inline-vis` in the test runtime. If both it and
  Kitchen Sink are enabled, BB renders the duplicate directive as literal text.
- Smart diff content freezes after the first successful render for that
  message. Use a fresh directive/message when changing a fixture for another proof.
- HTML paths must stay inside the thread workspace. The file limit is 5 MiB.
- Unsupported, oversized, or unparseable Unity data falls back to YAML with a notice.
- Keep fixture files until the evidence is captured. An expanded HTML preview
  needs its source file when the page loads again.

Source entry: `plugins/kitchen-sink/src/app/app.tsx` registers these message directives.
