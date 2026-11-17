---
name: captain-brief
description: Write the brief for a crew thread, the description of the task the Captain dispatches. Use before every bb tasks create that starts crew work.
---

# Captain brief

A brief is the task's description. The crew thread reads it as its whole assignment, so it holds only what this task needs: the change, done means, scope, and what the thread can rely on. The role contract and `CREW.md` already carry the standing rules.

## Write it

1. Copy the template below into a file in the Drive, such as `briefs/<slug>.md`.
2. Fill every section. Each done-means item must be something you can check yourself from the commits, tests, PR or a run.
3. Create the task with `bb tasks create --project <KEY> --title "<title>" --description-file <file>`.
4. Dispatch it with `bb captain dispatch <task> --role <role>`.

The brief is done when every section is filled and each done-means item names a check.

```text
You are a crew thread for the <name> Captain.

<The change in one or two sentences.>

## Done means
<Testable outcomes, numbered. The Captain checks behavior against these.>

## Out of scope
<Where this thread's ownership ends: files, features, repos it must not touch.>

## What you can rely on
<Checkout or worktree, the branch it owns, model, test instance, what other threads are touching.>

## Rules
<What comes back to the Captain and what it decides alone. CREW.md applies.>

## Report
<What the final comment holds. Files go on the task with `bb tasks attachment add` or `--attach`.>
```

## Leave out

- The role's contract: dispatch delivers it. Do not restate how to report, commit or review.
- Rules already in `CREW.md` or `repos/<KEY>.md`.
- Your own guesses at the cause or the fix, unless you checked them. Mark anything unchecked as a hypothesis.
- **For a Review brief:** the implementer's report and conclusions. Review gets the brief and the diff, so its lenses stay blind.
- Secrets and credentials. The thread requests them with `bb secret request`.

## Steer Review

- Add a `Lenses:` line to a Review brief to add or drop lenses, such as `Lenses: +visual -performance`, or to name a Drive lens.
- Without it, the Review thread picks lenses from the diff.
