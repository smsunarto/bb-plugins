---
"@smsunarto/bb-plugin-agent-proxy": minor
"@smsunarto/bb-plugin-agentation": minor
"@smsunarto/bb-plugin-amp": minor
"@smsunarto/bb-plugin-gh-stack": minor
"@smsunarto/bb-plugin-monokai": minor
"@smsunarto/bb-plugin-notify": minor
"@smsunarto/bb-plugin-t3sidebar": minor
---

Require bb 0.38 and take the SDK types from the published `@get-bb/plugin-sdk`
package. `engines.bb` is now `>=0.38.0 <0.39.0`, so an older bb no longer
installs these plugins.

Agent Proxy gains a `routingStrategy` setting (`round-robin`, `fill-first`, or
`weighted-round-robin`) that it writes to the core `config.yaml`. Pick
`fill-first` to keep several Claude OAuth accounts from rotating away the
upstream prompt cache.
