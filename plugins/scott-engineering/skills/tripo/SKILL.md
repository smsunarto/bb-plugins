---
name: tripo
description: Generate or process 3D models and images with the local Tripo Studio CLI. Routes to its embedded Studio-specific skill.
---

# Tripo

Read the embedded skill from the tracked Studio wrapper:

```sh
"$HOME/.local/share/cli-overrides/bin/tripo" docs --llm
```

Follow that output for the user's task. Load its referenced topics with the same
executable's `docs --topic` command only when needed. Use that executable for
subsequent Tripo commands so the documented Studio behavior applies.

If the wrapper is missing or reports an unsupported version, resolve that
installation or compatibility issue before generating. Do not substitute an
upstream executable or `npx tripo-cli`, which uses different authentication and
billing. The embedded skill owns the operating details; keep this file a router.
