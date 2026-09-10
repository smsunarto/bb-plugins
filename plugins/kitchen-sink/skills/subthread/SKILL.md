---
name: subthread
description: Do the requested work in a linked BB subthread. Use when the user invokes /subthread.
disable-model-invocation: true
---

Do the supplied task, or the current conversation's task, in one BB child
thread. Ask what to delegate only if no task is clear.

Run `bb status --json` for the current project and environment IDs, then:

```sh
bb thread spawn --parent-self --project <project-id> --environment <environment-id> --title "<task title>" --prompt "<self-contained task and context>" --json
```

Include constraints and expected verification in the prompt. Tell the child to
do the work itself without delegating it again. Keep this thread for coordination.

Link the returned child thread. Use `bb thread wait <id> --timeout 60` and
`bb thread output <id>` to monitor and read results. Send follow-ups with
`bb thread tell <id> "<message>"`. Report the result and verification here, or
the blocker if unfinished. Idle alone does not mean the task is complete.
