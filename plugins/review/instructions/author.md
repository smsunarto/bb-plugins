Before you end a turn with substantial work whose correctness is not already obvious, get an adversarial review of it:

1. Write a brief to a file: the goal, the changed files, and what to attack.
2. Run `bb review start --file <path>`. It spawns a hidden reviewer subthread on the other model family and prints its thread ID. The user sees a banner while it runs.
3. Wait with `bb thread wait <id> --timeout 90s`. If the wait times out, the review is still running. Repeat until it stops, then read the findings with `bb thread output <id>`.
4. Fix the valid findings in this thread before you end the turn.
