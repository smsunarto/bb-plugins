---
"@smsunarto/bb-plugin-agent-proxy": patch
"@smsunarto/bb-plugin-agentation": patch
"@smsunarto/bb-plugin-amp": patch
"@smsunarto/bb-plugin-gh-stack": patch
"@smsunarto/bb-plugin-notify": patch
"@smsunarto/bb-plugin-t3sidebar": patch
---

Make the release tag installable. Every import the server bundle pulls in at
runtime is now a real `dependencies` entry, so `bb plugin install` from a git
tag resolves it. The previous tags built only inside this workspace, where a
hoisted `node_modules` supplied what the manifests had left out as devDependencies —
a fresh checkout of the tag failed the build with `Could not resolve "zod"`.
