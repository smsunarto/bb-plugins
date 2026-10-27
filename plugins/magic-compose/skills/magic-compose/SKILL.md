---
name: magic-compose
description: "Route a prompt to the best project, machine, model, and reasoning level with the Magic Compose plugin, or inspect how it would route."
---

# Magic Compose

Magic Compose asks Jev, a fast classifier model, where a new thread should run. It
chooses among the projects and environments the user allowed, the connected
machines, and the models in the user's rotation, following routing instructions
the user wrote in the plugin's settings.

## Commands

```sh
bb magic-compose route "<prompt>" --json
bb magic-compose spawn "<prompt>" --json
bb magic-compose machines --json
bb magic-compose rotation get --json
bb magic-compose preferences get --json
bb magic-compose history --days 14 --json
```

- `route` reports where the prompt would go and starts nothing. Each of
  `project`, `machine`, `model`, `reasoning`, and `environment` carries the
  pick's `label`, its `probability`, Jev's `confidence`, and the runner-up
  `alternatives`. A `source` of `only-option` means there was nothing to choose
  between; `fallback` means the preferred environment was unavailable for that
  project or machine and the next best was used.
- `spawn` routes the prompt and starts a visible thread there. It prints the new
  thread id and the same decision. Only use it when the user asked for a thread
  to be started; starting threads is otherwise outside an agent's remit.
- `machines` prints what Jev is told about each connected machine: operating
  system, CPU load, memory, free disk, and running agent threads.
- `preferences get|set` reads and writes the routing instructions and the other
  preferences. They are not BB plugin settings, so `bb plugin config` does not
  reach them; only the API keys and the choice of gateway are.
- `rotation get|set`, `history`, and `backtest` read and tune the model
  preferences; the `tune-magic-compose` skill explains how to use them together.

## Constraints

- Every call needs a Vercel AI Gateway or OpenRouter key and at least one model
  in the rotation, both set by the user in Settings → Magic Compose. Without them the
  command exits 1 with a message saying which is missing. Do not ask the user to
  paste the key into chat.
- `route` and `spawn` each normally make one Jev request. Add `--profile` to
  `route` for a timeline of where the time went. Vercel's free tier
  allows about 10 Jev calls per 5 minutes, so do not loop over many prompts.
- Treat a pick with confidence under about 0.5 as a guess. Prefer `route` and
  show the user the alternatives before spawning on a guess.
- The prompt, project names and folders, recent thread titles, and machine names
  are sent to TypeSafe through Vercel or OpenRouter. Do not route prompts containing secrets.
