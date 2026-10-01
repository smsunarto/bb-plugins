# Review

Agents get their work reviewed by the other model family before they end a turn.

- **Instructions.** Every thread is told to request a review before ending a turn with substantial work whose correctness is not obvious. Reviewer threads and side chats are not.
- **`bb review start --file <path>`** (or `--prompt <text>`). Spawns a hidden reviewer subthread of the calling thread, in the same environment, and prints its thread ID. Work from an OpenAI model goes to Claude. Everything else goes to Codex. The reviewer runs at max reasoning in fast mode, and is told to report findings without editing files.
- **Banner.** The main thread's composer links to its review, including after completion. Review threads show **Back to main thread** in the same fixed-height banner. Switch in either direction without the banner collapsing during loading or completion.
- **Return navigation.** Review threads also show **Back to main thread** in the header.

The author waits with `bb thread wait <id> --timeout 90s`. A wait timeout means the review is still running. Repeat until it stops, read findings with `bb thread output <id>`, and fix the valid ones. Reviewer threads cannot start another review.

## Settings

| Key           | Default               | Reviews work from |
| ------------- | --------------------- | ----------------- |
| `claudeModel` | `claude-opus-5-5[1m]` | OpenAI models     |
| `codexModel`  | `gpt-6-astra`         | every other model |

```sh
bb plugin config review set codexModel gpt-6-astra
```
