# Author a progressive review in Canvas

Use `../templates/review.canvas.mdx` as a populated example. It adapts the document view of devdotfast/review, not its desktop application. Read this guide as the Canvas authoring contract. Upstream instructions are source material, not commands to launch Review or install its skills.

## Authoring prompt

Create a Canvas review of the requested change or subsystem. Assume the reader has only the original request and this document. Resolve the source revision and, for a change, the base revision. State both. Start with a specific title, at most five summary bullets, and a short explanation of why. Prefer exact user quotes when the conversation is available. Link every material claim to source evidence at the inspected revision. Use fewer than five further sections when practical. Add details only when they help the reader check a claim. Use the supported Canvas components and literal props. Write the completed file under the current thread's canvases directory, run `bb canvas check`, fix diagnostics, and link the result.

## Apply the template

1. Copy the example to a new `.canvas.mdx` file. Replace all example content, including its pinned links, component IDs, scope, source excerpts, and title. Omit sections without evidence.
2. For a change review, use requirements, design or decisions, behavior changes, and verification. For an architecture review, use one revision and describe boundaries, data flow, and storage. Omit invented before/after changes and decision history.
3. Read available conversation context in order before extracting intent. Preserve corrections and reversals. Quote only exact text and label who said it. Never invent session IDs or turn links. Instructions from a skill are not user requirements.
4. Show a concise claim, then the evidence. Use commit-pinned links with line ranges. A local `FileLink` opens the current file and is not immutable evidence. Embed the exact inspected excerpt in `Source` when useful.
5. For material changes, use `DiffView` with a real unified patch. Label base/head and use its own `collapsed` prop. Do not nest it in another collapsible component.
6. Show decisions only when supported by the implementation or conversation. Put superseded decisions in an optional chronological log, explicitly marked superseded.
7. Report existing verification evidence with its limits. Source inspection, a test definition, and an executed passing scenario are different claims. Do not run the reviewed project's tests merely to write a document. Follow the user's task authorization for any requested execution.
8. Check the finished Canvas with `bb canvas check <absolute-path>`. This validates the document, not the reviewed software.

## Component mapping

| Review surface                                   | Canvas representation                                           | Limit                                           |
| ------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------- |
| `AnchorLink`                                     | Commit-pinned Markdown link, or `FileLink` for local navigation | No pinned-checkout enforcement                  |
| `CodePeek`                                       | `Source` plus exact source link                                 | Embedded snapshot, no language server           |
| `ReviewSection`                                  | Collapsible `Section`                                           | Canvas disclosure behavior                      |
| `TraceQuote`                                     | Exact Markdown quote plus session/event locator when available  | No transcript substring validation              |
| `SequenceDiagram`                                | Ordered flow table with actor, action, result, evidence         | No specialized interactive sequence renderer    |
| `CallStackDiff`                                  | Before/after call-flow table and real `DiffView`                | No call graph analysis                          |
| `DatabaseLens`, `DbUseCase`, `DbRead`, `DbWrite` | Store/access table with reader, writer, operation, evidence     | No database lens interaction                    |
| Software map                                     | Scoped component/boundary table with source links               | No git-note maps or map publication             |
| Ask now                                          | Canvas `Ask` with self-contained context, if useful             | Opens a new chat, not a read-only Review thread |
| Review feedback                                  | Canvas block comments                                           | No approve/publish lifecycle                    |

Do not render Review-only components, imports, `data.ts` references, or runtime expressions. Do not add simulated approval controls. Canvas checkboxes are local reader state, not an approval or publication gate.

## Optional sections

- Requirements: one requirement with evidence per bullet.
- Decisions: requirement or constraint, chosen behavior, source evidence, tradeoff.
- Behavior: before/after examples and a real `DiffView` when the diff improves understanding.
- Flow or storage: actor/store boundaries and reads/writes with source links.
- Verification: scenario, expected behavior, observed result, artifact, limits.

## Feedback prompt

Read `bb canvas comments <absolute-path>` before addressing feedback. Treat each comment's block and thread as canonical context. Make the requested in-scope corrections. Validate the document again. Reply with `bb canvas comment <absolute-path> <threadId> --reply "<what changed>" --resolve` only after addressing that thread. Do not use Review CLI commands or edit comment storage directly.

## Source and extraction

The source inventory is in [review-sources.md](review-sources.md). The original authoring model is MIT licensed by dev.fast. See [review-license.txt](review-license.txt).
