---
name: write-github-issue
description: Draft, review, or file a GitHub issue from a diagnosis or feature request, using Scott's concise, source-grounded issue style.
---

# Write GitHub Issue

Write as a peer describing what they found and proposing a change. Use the
[worked example](references/example-issue.md) when a full report would help calibrate the voice.
Its historical diagnosis is an example, not evidence for the current issue.

## Establish the facts

Read the code behind the behavior and cite the path and symbol from this investigation.
Reproduce it when practical. Otherwise state that it is unverified and give a plausible
reproduction recipe. Separate observations, source-supported mechanisms, and hypotheses.
Do not require a known root cause to report a useful defect.

Before filing, inspect the repository's issue template and search open and closed issues,
including alternate wording for the symptom. Use relevant existing investigation results
instead of repeating them. For a supplied-draft review, investigate only what the requested
review needs and identify any checks not performed.

## Draft

Repository templates and established title conventions take precedence. Otherwise prefer
`<type>(<scope>): <subject>` with the repository's vocabulary, a lowercase subject, and no
trailing period. A bug title states the defect; a feature title states the desired behavior.

Start with observed behavior or the requested capability, then explain the evidence and
proposal. Use headings only for material the issue actually has:

| Heading      | Content                                                     |
| ------------ | ----------------------------------------------------------- |
| Refs         | Relevant prior art and related issues                       |
| What happens | Trigger, observed behavior, measured impact                 |
| Why          | Source-supported mechanism, with uncertainty identified     |
| Proposal     | What we should change, with a diff or signature when useful |
| Evidence     | Trimmed logs, errors, measurements, or visuals              |
| Reproduction | Reproducible steps or a failing test                        |
| Environment  | Versions and configuration that affect the diagnosis        |

Use first person for observations and collaborative language for proposals. Prefer plain
words and short paragraphs. Let measured impact carry the argument. Code blocks should
contain real artifacts, not prose. Keep secondary findings optional and brief. Do not invent
observations to imitate the example or force every issue into all seven headings.

For meaningful screenshots, recordings, or diagrams, show them beside the claim they
support. Inspect captures and label prototypes accurately. Omit decorative visuals.
When a recording is needed, use `media:demo` for capture, review, and delivery, then
include the result with the issue's evidence.

## Deliver or file

Read the draft once for unsupported claims, unnecessary explanation, and private details.
Redact credentials and private identifiers with consistent placeholders. Keep agent, AI,
and model attribution out of the issue.

A draft or review request ends with the reviewable draft. If filing is already authorized,
publish it without asking again. Otherwise present the draft before asking for publishing
approval. For filing and attachment mechanics, read [publishing.md](references/publishing.md).
