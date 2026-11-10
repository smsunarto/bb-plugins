---
description: Untrusted input, permissions, secrets, or sensitive data crosses a boundary.
---

# Security

Follow attacker-controlled data and authority across trust boundaries. Suggestions to investigate:

- Input reaching SQL, shell commands, evaluation, filesystem paths, or HTML rendering.
- Authentication, authorization, tenant isolation, and ownership checks at entry points.
- Secrets or sensitive data exposed in source, logs, error messages, or responses.
- Time-of-check to time-of-use gaps around permissions or sensitive operations.
- Whether parsing, validation, and escaping apply to the actual representation consumed downstream.

For a finding, show the reachable input path, the missing protection, the dangerous operation, and the resulting impact. Verify relevant framework and library behavior before claiming a defense is absent. Follow supporting code as needed to explain the change's exposure.
