---
"@smsunarto/bb-plugin-amp": patch
---

Put `@get-bb/plugin-sdk` in `dependencies` so a git install can bundle the provider bridge. Managed installs run `npm install --omit=dev`; a devDependency-only pin left the host builder without the SDK subpath it inlines.
