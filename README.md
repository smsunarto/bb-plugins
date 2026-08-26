<div align="center">

# smsunarto's bb-plugins

**Plugins for [bb](https://github.com/get-bb/bb), the agent IDE — in one GitHub repository.**

![bb 0.40+](https://img.shields.io/badge/bb-0.40%2B-88C0D0?style=flat-square)
![Bun workspace](https://img.shields.io/badge/Bun-1.3.14-3FA266?style=flat-square)
![macOS · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-F1B467?style=flat-square)

</div>

<picture><img src="docs/media/hero.png" alt="A staged overview of bb with the Monokai palette, GTD Sidebar, Agent Proxy, Agentation, and GitHub Stack" width="100%" /></picture>

### Agent Providers

<table>
<tr>
<td align="center" width="60"><picture><source media="(prefers-color-scheme: dark)" srcset="plugins/agent-proxy/assets/logo-dark.svg" /><img src="plugins/agent-proxy/assets/logo.svg" width="40" height="40" alt="" /></picture></td>
<td align="center"><a href="plugins/agent-proxy/"><b>Agent Proxy</b></a></td>
<td>Pools several Claude Code and Codex subscriptions behind one local endpoint and load-balances across them, moving on when one hits its quota.</td>
</tr>
<tr>
<td align="center" width="60"><picture><source media="(prefers-color-scheme: dark)" srcset="plugins/amp/assets/logo-dark.svg" /><img src="plugins/amp/assets/logo.svg" width="40" height="40" alt="" /></picture></td>
<td align="center"><a href="plugins/amp/"><b>Amp</b></a></td>
<td>Runs <a href="https://ampcode.com">Amp</a> as a native bb provider, locally or in an Orb.</td>
</tr>
</table>

### Dev Productivity

<table>
<tr>
<td align="center" width="60"><picture><source media="(prefers-color-scheme: dark)" srcset="plugins/agentation/assets/logo-dark.svg" /><img src="plugins/agentation/assets/logo.svg" width="40" height="40" alt="" /></picture></td>
<td align="center"><a href="plugins/agentation/"><b>Agentation</b></a></td>
<td>Turns a click on any part of bb into a structured annotation an agent can act on.</td>
</tr>
<tr>
<td align="center" width="60"><picture><source media="(prefers-color-scheme: dark)" srcset="plugins/gh-stack/assets/logo-dark.svg" /><img src="plugins/gh-stack/assets/logo.svg" width="40" height="40" alt="" /></picture></td>
<td align="center"><a href="plugins/gh-stack/"><b>GitHub Stack</b></a></td>
<td>Drives a <code>gh stack</code> from the thread panel — build, sync, submit, merge — and can hand the split to your agent.</td>
</tr>
</table>

### Utilities

<table>
<tr>
<td align="center" width="60"><picture><source media="(prefers-color-scheme: dark)" srcset="plugins/notify/assets/logo-dark.svg" /><img src="plugins/notify/assets/logo.svg" width="40" height="40" alt="" /></picture></td>
<td align="center"><a href="plugins/notify/"><b>Notify</b></a></td>
<td>Real macOS notifications from bb itself when a thread finishes or fails, plus a <code>notify_user</code> agent tool.</td>
</tr>
<tr>
<td align="center" width="60"><picture><source media="(prefers-color-scheme: dark)" srcset="plugins/gtd-sidebar/assets/logo-dark.svg" /><img src="plugins/gtd-sidebar/assets/logo.svg" width="40" height="40" alt="" /></picture></td>
<td align="center"><a href="plugins/gtd-sidebar/"><b>GTD Sidebar</b></a></td>
<td>An action-oriented thread list with Next Action and Waiting sections. Forked from <a href="https://github.com/get-bb/bb/tree/main/examples/plugins/t3sidebar">bb's own example</a>.</td>
</tr>
</table>

### Themes

<table>
<tr>
<td align="center" width="60"><picture><source media="(prefers-color-scheme: dark)" srcset="plugins/monokai/assets/logo-dark.svg" /><img src="plugins/monokai/assets/logo.svg" width="40" height="40" alt="" /></picture></td>
<td align="center"><a href="plugins/monokai/"><b>bb Monokai</b></a></td>
<td>A dark Monokai-family palette for the whole app: one meaning per hue, a single text ladder, all 16 ANSI colors, and a matching diff viewer.</td>
</tr>
</table>

## Install

Add this repository as a marketplace once, then install by name:

```sh
bb marketplace add git:github.com/smsunarto/bb-plugins
bb plugin install notify
```

Adding a marketplace installs nothing — it caches the catalog, so these plugins
become findable by name in `bb plugin search` and in bb's plugin browser. `<id>`
is `agent-proxy`, `agentation`, `amp`, `gh-stack`, `gtd-sidebar`, `notify`, or
`monokai`; if another marketplace you have added publishes the same name, spell
it `notify@smsunarto`.

Every plugin ships as a git tag, and the catalog entry carries its release line.
bb resolves the newest `<id>/vX.Y.Z` tag, clones it, installs the plugin's
runtime dependencies, and builds both bundles against your bb — a plugin is
never shipped prebuilt, so it always matches the host it runs on. `bb plugin
update <id>` follows the same line.

## Build from source

This is the route for unreleased work. It puts each plugin in as a **local path source**, so bb reads the files in place: edit, rebuild, reload — no reinstall.

```sh
git clone https://github.com/smsunarto/bb-plugins
cd bb-plugins
bun install                              # one hoisted node_modules at the repo root
bun run build                            # bb plugin build for every plugin
bb plugin install ./plugins/<id>         # from the repo root
```
