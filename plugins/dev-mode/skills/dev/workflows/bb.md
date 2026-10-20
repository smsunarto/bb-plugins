# BB adapter for pstack workflows

Read the selected playbook, then follow its steps. The imported workflow text keeps pstack's wording except for names, reference paths, and unavailable harness integrations.

- `how` means [How](how/workflow.md); `why` means [Why](why/workflow.md); `show-me-your-work` means [Show me your work](show-me-your-work/workflow.md). These are bundled references, not slash commands or additional catalog skills.
- `architect`, `arena`, `swarm`, and `review` mean this fork's bundled skills. Native Arena owns candidates, judging, synthesis, verification, and integration; do not manually spawn its phases. The `interrogate` review step uses the existing native Review workflow and its lead-judgment policy.
- Before native Architect launches Arena for Feature, complete the throughput checkpoint from Feature step 3. Pass the grounding, checkpoint, requested artifact, and acceptance criteria, not the playbook's orchestration steps. Native Arena owns implementation, judging, synthesis, verification, and integration (Feature steps 4–6). The coordinating author owns step 7 review and step 8 authorized publication when the completed run returns to handoff. Emit the card and yield; do not also delegate or redo implementation.
- Include this worker-facing boundary in the Arena task: "Complete your assigned design/implementation and verification. Do not delegate, restart workflows, commit, rebase, push, or open a PR; native Arena owns worker orchestration and integration." Worker roles and the no-nesting contract override playbook fan-out steps.
- For other authorized delegation, use the models, environment selection, prompt contract, and collection rules in `../../../references/subthreads.md`. Cursor Task flags, custom agent types, and `pstack-models.mdc` are not BB configuration. Delegates stay inside their assigned role and never restart orchestration.
- Read named principle references with `bb dev-mode principle --name <name>`. They remain shared references. Grug Brain is this fork's replacement for Laziness Protocol.
- Use the installed control skill for the affected surface, such as `agent-browser` or `control-cli`. If the required control is unavailable, report the specific gap rather than claiming verification.
- Follow session and repository rules for GitButler, worktrees, commits, publishing, skill-authoring authority, and retained artifacts. A playbook's Opening a PR step applies only when publication is authorized. Keep decision trails outside tracked source unless the task calls for a committed trail.

Cursor-only Bugbot, Babysit/Shipping automation, Orchestrate, Autopilot, multi-phase plan tooling, and worktree-cleanup tooling are not bundled here.

The upstream Eval playbook is omitted: ordinary BB candidates receive live Dev Mode instructions and skills, so a scratch directory cannot provide its required blinding or isolate a prompt variant. Do not claim a blinded prompt evaluation from that setup.
