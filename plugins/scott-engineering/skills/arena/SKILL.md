---
name: arena
description: "Run competing attempts at one task, judge them independently, and synthesize their strongest parts. Use for /arena, 'arena this', 'throw it in the arena', when Architect invokes it, or after an accepted suggestion. Do not launch unprompted."
---

# Arena

Use the native `scott_engineering_arena_start` tool with the user's task and a stable requestId. A retry of the same request uses the same ID. Include relevant grounding as explicit task context. Do not spawn or coordinate candidates yourself.

Emit the returned `::arena{run="..."}` directive in your assistant message. It renders a live embedded summary with candidate approaches, the synthesis decision, verification, round history, worker links, and Stop Arena.

The run continues independently when the main chat stops, resumes automatically after BB restarts, and performs at most three total rounds. It integrates the synthesis automatically after successful verification. Stop with `scott_engineering_arena_stop`; read state with `scott_engineering_arena_status` when needed. Do not poll.

The first native workflow requires a ready Git project that permits BB-managed worktrees. If the repository requires a canonical checkout or a lease you do not hold, explain that constraint before launching.

Candidates work independently on the same task. An independent judge scores completed outputs; synthesis chooses a base and explains grafts and rejected ideas. The synthesis worker prepares the merged tree and runs verification through its normal tools and inherited permissions. The host applies only a passing, unchanged result. No worker turn reawakens the launching chat; the embedded summary updates live.
