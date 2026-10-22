# Author a Whiteboard

Write an interactive code walkthrough for a staff engineer. Start with the change and its purpose, then show the design and the code that delivers it.

## Start

1. Read `whiteboard_session_capabilities`. Register the repository on its owning host, then create the review with the target the user requested. A GitHub PR can be created from `pullRequestUrl` alone. Use the returned target and resolved commits as the source of truth.
2. For a PR, read its description for the author's stated purpose and requirements. Keep that context separate from what the code proves.
3. Delegate Diff-view grouping to a subagent: "Call `whiteboard_session_get_instructions({topic:\"file-lenses\"})` and follow it for Whiteboard <sessionId>." Include the session ID and the returned target. The document and lenses use separate leases.
4. Begin `whiteboard_session_activity` with a fresh `leaseId` and `scope: "document"`. Pass that lease on every document write. Renew it during long reads, update its focus as you work, and end it when finished.
5. Read the pinned change with `whiteboard_session_diff`. These source tools run on the repository's host. If a requested change produces an unexpectedly empty diff, check the returned base and head and correct the target with `whiteboard_session_set_target` before writing. A source-only explanation can intentionally have no diff.
6. Put down the first what/why section as soon as you have read the diff and the PR description. Continue in small edits so the reader sees progress.

## Structure

Use top-level `section` components in this order. Omit sections the change does not need.

- **What/why:** What changes for the consumer and why the change was made. Attribute intent to the PR description, user, or other evidence when available.
- **Requirements:** The user's requirements, in their own words, as short bullets. Omit when unavailable.
- **Design:** Components, data, and control flow. Choose the visual that carries the design:
  - `sequence` for participants interacting over time or across async handoffs.
  - `flow_diagram` for branches, retries, and state transitions.
  - `database_lens` for stores, schema, and reads or writes.
  - `code_peek` for a contract's key types or interfaces.
  Include decisions, tradeoffs, and alternatives when evidence supports them.
- **Implementation:** Follow the changed code from the user or agent entry point. Use `call_stack_diff` for the old and new paths, including unchanged steps needed to understand them. Use `code_peek` for the mechanism or invariant; link other code inline.

## Write and cite

- Keep each prose run to at most three sentences before a visual component. When a visual carries the same information, let it carry the explanation. Finish a short explanation when complete; add visuals only where they explain something.
- Use short sentences, concrete terms, and one meaning per sentence. Define an unfamiliar term where the reader first needs it.
- Attach code evidence to diagram nodes and arrows, and link code named in prose. Read the source at the review's pins before citing it.
- A sequence arrow's source is the line where the call, return, or event leaves its `from` actor. Show the callee's body in the following step. Use an explanation or illustrative code when no source backs an arrow.
- Link repository code as `[label](review-source:head/src/file.ts#L10-L24)`, or use `base` for old code. Use repository-relative paths and verified, inclusive line numbers.
- Insert a new diagram whole. Change an existing diagram by its node, edge, or step IDs, keeping each new flow node connected to a node already drawn.

## Finish or update

Before ending the document lease, call `whiteboard_session_get({sessionId, full: true})`. The default outline abbreviates prose. Check the complete document for contradictions, unsupported claims, and citations that no longer match the source, then fix them.

For an existing Whiteboard, read it in full, move it to the new target with `whiteboard_session_set_target`, and address the returned source warnings. Read the change since the prior target and update the existing document, preserving component IDs where they still describe the same thing. Read it back in full before finishing.
