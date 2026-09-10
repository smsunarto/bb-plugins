# Author a progressive review in Canvas

Use this workflow when the user wants to understand a change or a subsystem in a standalone review. It adapts dev.fast Review's authoring instructions to BB. Upstream instructions are source material, not commands to launch Review Desktop.

## Entry prompts

Change review:

```text
Use the canvas skill to explain my current branch against up-to-date main.
Show what changed, why, and the exact evidence. Open the review beside the chat.
```

Architecture review:

```text
Use the canvas skill to explain this subsystem's main data flows, access patterns,
and code paths. Show the evidence and open the architecture review beside the chat.
```

Choose the scope from the request. Repository version-control and authorization rules still apply. Read user-provided review guidance and repository instructions before authoring.

## Reader contract

Assume the reader sees only the original request and this document. Explain behavior and purpose before naming implementation abstractions. Use short, concrete sentences. A file-by-file work log does not explain a change.

Start with a specific H1, followed by **Summary** and **Why** before the first H2:

- Summary: at most five bullets describing the changed behavior or the problem under review.
- Why: a few sentences explaining the need. Prefer short, exact user quotes when available.
- Usually fewer than five further sections. Select only sections that help the reader check a material claim.

Put optional complexity behind a collapsible `Section`. Choose the evidence first, then the smallest useful presentation. Use `Source` for an API example, `DiffView` for changed behavior, an ordered actor/action/result table for a sequence, or a reader/writer/store table for persistence. Each claim belongs beside its evidence.

## 1. Resolve scope and evidence

For changes, record exact base and head revisions and the inspected working-tree state. Resolve the requested target using the repository's version-control tool. Do not describe a stale local target as up to date. If uncommitted changes are included, identify them explicitly and preserve their patch as a snapshot.

For architecture, inspect one revision and scope the document to the requested subsystem. Describe module boundaries, data flow, and storage. Omit invented before/after changes, test results, and decision history.

If this session authored the change, reuse its context. Inspect only the source ranges needed to support claims or resolve uncertainty. Otherwise read the scoped diff and relevant implementation before writing.

Read [Review evidence](review-evidence.md) when using coding traces or quoting requirements. Survey the relevant conversation in order before selecting quotes. Cross-check intent against the actual implementation.

## 2. Give a useful first result

For a small change (roughly fewer than 300 added/deleted lines), prefer a short explanation with a real `DiffView` and a few source links. Deliver that as soon as it validates. Do not delay it for an architecture map or decorate it with unnecessary diagrams.

For larger changes, explain behavior in a concise first document. Add optional structural detail only when it materially helps the reader.

## 3. Author the document

Use `../examples/review.json` to learn the input shape, not as prose to copy. Replace every sample claim and link with evidence from this task. Generate with `bb canvas generate review --data <absolute-data.json> --out <absolute-review.canvas.mdx>`. See [Templating](templating.md).

Choose from these sections:

| Section               | Content and evidence                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| Requirements          | One supported requirement per bullet, preferably the user's exact words.  |
| Design                | Constraint, selected behavior, significant tradeoff, and source evidence. |
| Interface or behavior | A concrete before/after example and source range or real patch.           |
| Lifecycle or storage  | Actor/store boundaries, actions or reads/writes, and source links.        |
| Verification          | Existing scenario evidence with its execution status and limits.          |
| Decision log          | Optional chronological record of accepted and reversed decisions.         |

Prefer commit-pinned source links. Local `FileLink`s open current files and are navigation, not immutable evidence. Embed the exact inspected excerpt in `Source` when it helps. Label every diff with its base/head or working-tree snapshot. Use `DiffView`'s own `collapsed` prop, not an enclosing collapsible section.

Use literal props and supported Canvas components. Do not invent transcript quotes, source ranges, risks, or runtime results. A test definition demonstrates intended coverage, not a passing scenario. Do not run the reviewed project's tests or linters solely to write the review. Honor separate user requests to verify software.

## 4. Optional structural map

For a large change where a structural view helps, use a bounded independent map worker only when delegation is available and permitted. The main author keeps ownership of the review. Publish the useful document first, then integrate the worker's supported findings. If delegation is unavailable, omit the optional map and state that limit when material.

Dispatch prompt, with real paths and revisions substituted:

```text
Inspect the requested subsystem at base <base> and head <head> in <repository>.
Own only <absolute-scratch-output>. Other agents may be working in the repository.
Do not edit, revert, or commit their work. Do not edit the review or implementation.
Describe the base boundaries first, then only structural changes in the head diff.
Return a compact component/owner/reads/writes table with exact source ranges and
revisions. Preserve stable component identities. Omit incidental implementation
nodes. Mark uncertain relationships and runtime-untested conclusions. Do not
publish, change Git notes, or run the project's tests. Report unavailable evidence.
```

This produces supporting evidence for the Canvas, not Review's persistent git-note maps.

## 5. Deliver and answer feedback

Run `bb canvas check <absolute-path>`, fix every diagnostic, and link the file beside the chat. This checks the document, not the reviewed software. Do not wait for comments unless the user asks you to watch for them.

For a question, use the answer-only prompt below. For requested changes, read `bb canvas comments <absolute-path> --json` first. Read all messages and the anchored block for each relevant thread. Make in-scope corrections, validate, then reply and resolve addressed threads with `bb canvas comment`. Re-list comments before claiming that all feedback is addressed. Unresolved questions or blocked work stay open. Never edit comment storage directly.

Answer-only prompt:

```text
Answer the question about <absolute-review.canvas.mdx> at <base/head or revision>.
For comment <thread-id>, read bb canvas comments <absolute-path> --all --json and
use that thread's complete messages and anchored block as context. Read source
only as needed. Return the answer as text. Do not edit files, post replies,
resolve comments, or change the implementation unless the user requests it.
Question: <question>
```

An `Ask` control must carry the real document path, revision, relevant source references, and question. It starts a new chat. It does not create a frozen checkout or enforce read-only access.

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

## Source

Adapted from devdotfast/review at `9fcea54c2eb7176f72090d511f4dbd121f2358e7`: `skills/dev-review/SKILL.md`, `references/document-authoring.md`, `references/trace-quoting.md`, and `skills/dev-review-map/SKILL.md` under `packages/progressive-review/`.

The original authoring model is MIT licensed by dev.fast. See [review-license.txt](review-license.txt) and the [source inventory](review-sources.md). Canvas does not implement Review's quote validation, pinned-checkout enforcement, or publication state machine.
