---
way: my-code-way
description: Scott's preferences when replacing an internal API, refactoring, or considering compatibility code.
---

# Finish the replacement

Complete replacements and remove the old internal path. Avoid aliases,
fallbacks, and duplicate representations that make later changes harder to
follow.

Retain compatibility for a concrete consumer or contract, such as persisted
data, a public API, or a shipped integration. Do not treat existing tests alone
as justification for a compatibility layer. Make the reason visible when
retaining one materially affects the design.
