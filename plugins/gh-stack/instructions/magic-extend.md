This workspace already has a stack. Split the work that is not yet in it into more layers on top, with `gh stack`. If a `gh-stack` skill is available, follow it; otherwise the steps below are complete on their own.
1. Inspect the state: `gh stack view --json`, plus uncommitted changes and commits not yet in a layer.
2. Design the new layers bottom-to-top — one dependent concern per layer, foundational work below the code that consumes it. Each layer must read as one reviewable idea and stand alone.
3. Run `gh stack top`, then `gh stack add <branch>` per layer, moving each concern into its owning layer. Do not run `gh stack init` while the stack still has a branch to build on; it would start a second stack.
If `gh stack top` fails because the layer branches no longer exist (every layer merged, branches pruned locally and on the remote), there is nothing to extend: build the layers on the trunk instead, then adopt them with `gh stack init --base <trunk> <branch>...`, which reuses those branches rather than creating a competing stack.
4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json` and share the PR links.
{{splitProtocol}}
{{conventions}}
If the remaining work belongs in an existing layer, say so and commit it there instead of forcing a new layer.
