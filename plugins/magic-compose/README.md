# Magic Compose

Forked from [SawyerHood/sawyer-plugins](https://github.com/SawyerHood/sawyer-plugins/tree/d3424f24e2cebe91da4e72cb38feb023da808922/plugins/magic-compose) at `d3424f24e2cebe91da4e72cb38feb023da808922`. Copyright and MIT license retained in [LICENSE](./LICENSE). Local packaging uses `@get-bb/plugin-sdk` at this repository's SDK version.
A BB plugin that picks where a new thread runs. Switch on **Magic Compose**, the wand button beside the send button in the new-thread composer, and [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's classifier model, chooses the project, machine, model, reasoning level, and environment as you type. It calls Jev with your own key, through the [Vercel AI Gateway](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway), [OpenRouter](https://openrouter.ai/typesafe/jev-1.13), or both.

- With Magic Compose on, the composer's pickers follow the draft: Jev is asked again as you type, and the project, machine, environment, model, and reasoning pickers move to its answer. Nothing is hidden, so you see every choice, and you send the thread yourself.
- Send waits for Jev. From the first keystroke until the pickers match the text on screen, the send button is dimmed and Enter does nothing, so what runs is what you were shown. That is usually a fraction of a second after you stop typing.
- Change any picker by hand and it stays as you left it until Jev's answer for it changes. Permission mode is always yours.
- With Magic Compose off, the composer behaves exactly as it always has. The toggle is remembered per browser.
- Attachments and @-mentions are untouched: the composer sends the draft itself.

## Install

Run these commands on the machine hosting the BB server. The repository uses Bun workspaces, so build its framework before installing from the local checkout. BB's managed Git installer uses npm and cannot install the `workspace:*` dependency directly.

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run build:framework
bb plugin install ./plugins/magic-compose
```

## Set up

Open **Settings → Magic Compose**. The page runs in the order you need it.

1. **Configuration.** Paste a **Vercel AI Gateway API key** (Vercel dashboard → AI Gateway → API keys), an **OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)), or both. Keys are stored as secrets on the BB server and never sent to the browser. **Jev provider** picks which to use: `auto` uses whichever key is set, and with both set it asks the Vercel AI Gateway first and OpenRouter if that fails.
2. **Try it.** Route a prompt without starting anything. The line above it says whether Jev was reached, through which gateway, and how long the last decision took, so it is also the quickest check that a key works. Come back to it after every change below.
3. **In the composer.** What Magic Compose does while it is on:
   - **Magic Compose may set** chooses which pickers are Magic Compose's: project, machine and environment, model, effort. Switch one off and it is always yours. With the project off, Magic Compose routes within whichever project the composer is on. Effort needs Model, because Jev chooses the effort for the model it chose.
   - **Hold send until Magic Compose has decided** is on by default. Off, send is never held, and a draft may go before the pickers catch up with it.
   - **Ask Jev** is “As I type” by default. “When I pause” waits until typing stops, which sends far fewer drafts to TypeSafe and moves the pickers less.
4. **About you.** Anything Jev should always know, sent with every question: “I'm a solo developer. My main repo is bb.”
5. **Projects.** Leave **All projects** on, or turn it off and add the projects Magic Compose may choose between. **No project** is one of them, first in the list: it lets a prompt that fits no repository start a projectless thread. Below it, say how to choose: “Anything about the iOS app goes to the mobile project.”
6. **Machines.** What Jev is told about each connected machine, word for word, so you can see what your instructions have to work with: “iOS and macOS work must run on the MacBook. Prefer the Linux server otherwise.”
7. **Environments.** Where threads may work. **Worktree** alone is the default, so every thread gets a fresh git worktree. Switch on more than one and Jev picks per prompt, guided by what you write below: “Use a worktree for anything that changes code, the project checkout for questions.” A project none of them can serve, such as one that is not a git repository, falls back to Project checkout.
8. **Models and effort.** Add the models Magic Compose may pick, each with a note on when to use it, such as “UI design and planning”. You add models, not model-and-effort pairs: Jev picks the effort for each prompt from the levels the model supports and **Effort Magic Compose may use** allows. The effort shown on a row is only a fallback, for a model that offers no choice. `ultra` and `ultracode` are special run modes that cost far more, so they start off. Below, say how to choose: “Use Fable for UI design and planning, Opus for most other tasks, Sonnet for simple tasks.”

Two folds at the bottom hold what is rarely touched. **Permission mode** is for threads started with `bb magic-compose spawn`, lowered where the machine or provider allows less; in the composer, the permission picker is yours. **Advanced** has the Jev model id for each gateway.

Only the keys and the Jev provider are BB plugin settings. The rest are the plugin's own preferences, which `bb magic-compose preferences` reads and writes from a shell; `bb plugin config` does not reach them. BB draws declared settings as one flat card with no way to group them, and keeping the instructions beside the lists they govern mattered more.

## How a prompt is routed

Jev answers many questions about one piece of state in a single request, about as fast as it answers one. So Magic Compose follows TypeSafe's [speculative fan-out](https://docs.typesafe.ai/patterns/fan-out) pattern: every question that might matter goes out together, including ones whose relevance depends on an answer not known yet, and code keeps the answers that turned out to apply. A decision is normally **one request, 200–350 ms**.

- **Project** and **model**. Each project is described by its name, repository, folders, and recent thread titles; each model by your note and the provider's description.
- **Reasoning level**, asked once per model in the rotation (“if this runs on Fable, how much effort?”), because the levels on offer and the sensible default depend on the model.
- **Machine**, asked once per distinct group of machines. Projects that live on the same machines share a question. Each machine's description says which of your allowed environments it can create, so a rule like “prefer a machine where Btrfs Cow is available” works.
- **Environment**, asked once per machine that can create more than one. Only some environments exist on some machines, so each question names its machine and offers only what that machine can create for the project.

Your general instructions ride in the shared state; each question carries the instructions for its own choice. With a very large number of machine groups, the rarest questions wait for a second request.

Jev is weak at arithmetic and exact comparison, so code does the parts that need facts. Only machines that hold the chosen project, offer an allowed environment, and can run the chosen provider are offered. Machine load is put into words (“CPU load is low (7% of 16 cores)”, “busy, 3 agent threads running now”) beside the numbers. A question with a single candidate is not asked at all. Jev is only ever offered the effort levels you allow under **Effort Magic Compose may use**.

Machine details come from a small host entry that runs on each enrolled machine and reports its operating system, CPU count and load, memory, and free disk. See exactly what Jev is told with `bb magic-compose machines`.

A thread started with `bb magic-compose spawn` keeps its decision, with probabilities, in its plugin metadata.

### Keeping it fast

The facts code needs — what each machine is doing, which providers it runs, which environments it can create for each project — are cached and refreshed behind the scenes, so a dispatch never waits on a slow machine. Jev is reached over one long-lived HTTP/2 connection per gateway rather than a new connection per call: the first request on a new connection takes a second or more, and Node drops idle connections after four seconds, so without this nearly every dispatch paid that price. When Magic Compose is on, the composer asks the server to warm up as the screen opens: it opens that connection (priming a new one with a single trivial question) and refreshes the cached facts, so the first decision does not pay for them. While you type, at most one request is in the air and a new one starts no more than every 600 ms. `bb magic-compose route "<prompt>" --profile` prints a timeline of where the time went.

## CLI

```sh
bb magic-compose route "<prompt>" [--json] [--profile]   # where would this go? starts nothing
bb magic-compose spawn "<prompt>" [--json]               # route it and start the thread
bb magic-compose machines [--json]                       # what Jev is told about each machine
bb magic-compose rotation get [--json]                   # the model rotation
bb magic-compose rotation set '<json>'                   # replace it
bb magic-compose preferences get [--json]                # the instructions and the other preferences
bb magic-compose preferences set <key> <value>           # set one, for example modelInstructions
bb magic-compose history [--days 14] [--json]            # the model and effort you chose per thread
bb magic-compose backtest [--days 14] [--map <regex>=<model>]... [--exclude <regex>] [--json]
                                                         # score the rules against those choices
```

## Tuning it to how you work

The plugin ships a `tune-magic-compose` skill. Ask an agent to “tune Magic Compose's model preferences” and it reads which model and effort you chose for the threads you started (`history`), works out what separates them, writes the rotation notes and the model instructions, and checks them by routing your past prompts through Jev (`backtest`), reporting agreement next to the always-pick-your-favourite baseline. `--map` counts threads on one model as another, for example a preview model you would now replace with your regular one; `--exclude` keeps matching prompts from being sent. Expect agreement to be capped by the composer's sticky pickers: the same kind of task often sits at several efforts in anyone's history.

## Privacy and cost

With Magic Compose on, the draft is sent as you type, not only when you send it (or each time you pause, if you set **Ask Jev** to “When I pause”): every decision sends the prompt so far (the first 9,000 and last 3,000 characters of a long one), your instructions, project names, folders, remotes, and recent thread titles, and machine names and load to TypeSafe through the gateway you chose: the Vercel AI Gateway or OpenRouter. Jev costs $0.042 per million input tokens and a decision is a few thousand tokens, a small fraction of a cent; a prompt typed over ten seconds takes about fifteen of them. The Vercel AI Gateway's free tier allows only about 10 Jev calls per 5 minutes, which Magic Compose uses up within one prompt; any Gateway credit lifts that. OpenRouter bills the same price from your OpenRouter credit.

## Limits

- Magic Compose sets the pickers through the composer's own `setSelection`, so the values go in exactly as hand-picked ones do: the pickers remember them, and they count as your own choices in `bb magic-compose history`. The composer has the last word. It moves a reasoning level the model lacks to the nearest one it has, for instance, and its pickers show what it settled on.
- The plugin SDK has no way to hold a composer's send, so Magic Compose does that against the composer's DOM: capture-phase listeners swallow Enter and the send button while a decision is pending, and a stylesheet dims the button. The selectors live in `lib/composer-dom.ts` and `app.css`. A BB release that renames them stops the hold, so a draft could be sent a moment before Magic Compose has caught up with it; nothing worse.
- A failed round never holds the draft. If Jev cannot be reached, or takes more than eight seconds, the wand turns red, a toast says why once, and send works with the pickers as they are. Magic Compose tries again when the draft changes.
- Magic Compose works in any new-thread composer, including ones other plugins embed, but not in follow-ups to an existing thread.
- Choosing a project relies on names, folders, and recent thread titles. Similarly named projects need a line in **Project instructions**.

## Development

```sh
# From the repository root:
bun install
bun run --cwd plugins/magic-compose typecheck
bun run --cwd plugins/magic-compose test
bb plugin build ./plugins/magic-compose
bb plugin install ./plugins/magic-compose --yes
```

`lib/router.ts` holds the routing logic, `lib/live-fill.ts` schedules decisions as the draft changes, `lib/fill.ts` turns a decision into a composer selection, `lib/session.ts` keeps one Magic Compose session per composer, `lib/preferences.ts` is the plugin's own settings, shared by the server and the app, `lib/jev.ts` the Jev client for both gateways, `lib/transport.ts` the warm connection, and `lib/history.ts` the backtest scoring; all but the transport are pure and covered by tests. `server.ts` gathers candidates from the BB SDK and spawns the thread, `host.ts` reports machine stats, `app.tsx` owns the toggle, and `settings.tsx` the settings page.
