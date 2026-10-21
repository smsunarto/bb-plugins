# Session pickup

Resuming or taking over a prior agent's in-flight work from a BB thread, a transcript, or a pushed branch. Treat the prior trail as authoritative input rather than redoing it.

What tends to work:

1. Find the trail: `bb thread log <thread-id> --format json --all` for a BB thread, or the branch and its commits. Read the last messages first, then scan back for decision points. A subagent can reduce a long transcript to a timeline.
2. Reconstruct the state: the branch and worktree, what already landed (`git log`, a diff against the base), open todos, and decisions made.
3. Compare what shipped with what was planned and name the resume point. Re-running the prior repro or redoing finished work usually means the trail is being distrusted without cause.
4. Continue with the playbook that fits the remaining work: continue the execution, ship a finished recommendation, confirm or override a prior conclusion, or write up a failed run.
5. Check inherited claims against the original goal on the real artifact (`prove-it-works`). A prior self-report of success is not proof.

A good reply says where the prior agent stopped, what you inherited versus redid, the resume point, and the outcome.
