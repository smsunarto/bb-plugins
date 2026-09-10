---
way: my-go-way
description: Scott's preferences when designing, editing, or reviewing Go packages and types.
---

# Go package shape

Prefer concrete types and small exported APIs. Let consumers that need
interfaces own them. Prefer one primary struct per file, alongside its
constructor and closely related methods, to make navigation easier.

In a single-project repository, default to `cmd/<name>` and private
`internal/...` packages. In a monorepo, follow the existing application
boundary. Reserve `pkg/...` for intentionally shared code. Prefer shape
conversions at the boundary that owns them.
