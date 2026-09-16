Split the work in this workspace into a stack of reviewable branches with `gh stack`. If a `gh-stack` skill is available, follow it; otherwise the steps below are complete on their own.
1. Inspect the state: uncommitted changes plus commits not on the trunk branch.
2. Design the layers bottom-to-top — one dependent concern per layer, with foundational work (types, schema, shared helpers) at the bottom and the code that consumes it above. Each layer must read as one reviewable idea and stand alone; when in doubt prefer fewer, larger layers over many that only make sense together.
3. Create the stack with `gh stack init <branch>` and `gh stack add <branch>`, moving each concern into its owning layer.
4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json` and share the PR links.
{{splitProtocol}}
{{conventions}}
If the work is a single indivisible concern, say so and create a one-layer stack instead of forcing a split.
