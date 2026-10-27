---
name: tune-magic-compose
description: "Fill in and tune the Magic Compose plugin's model rotation, model instructions, and allowed effort levels from the user's own history of model and effort choices. Use when the user asks to set up, auto-fill, or tune Magic Compose's model preferences."
---

# Tune Magic Compose's model preferences

Magic Compose asks Jev, a fast classifier model, which model and reasoning effort
each new prompt should get. Jev chooses among the models in the user's
**rotation**, guided by a note on each model and by the **model instructions**.
This skill writes those from how the user has actually been choosing, then checks
the result against their history.

Read `skills/magic-compose/SKILL.md` for the routing commands. Everything you
write here lands in the user's BB settings, never in a repository.

## 1. Look at what the user picks

```sh
bb magic-compose history --days 14          # counts per model and effort
bb magic-compose history --days 14 --json   # plus every thread's prompt
```

Only threads the user started from a composer are counted; review bots,
automations, and Magic Compose's own dispatches are left out. Add
`--include-origin <plugin-id>` for another plugin whose threads the user starts
by hand. Go back further (`--days 30`) if there are fewer than about 100 threads.

Show the user the counts, then settle two things with them before going on, in
one question if you can:

- **Which models belong in the rotation.** Usually the two to four they use
  most. Preview, retired, or one-off models do not.
- **Whether some picks should count as another model.** Someone trialling a
  preview model would normally have used their regular strong model instead.
  Note each such mapping as `<regex on the model id>=<rotation model id>`.

## 2. Find what separates the groups

Read the prompts group by group: each model, then each effort within it.
Look for what kind of task lands in a group, in the user's own words.

Two things make this history noisier than it looks. Say so when you report,
and do not chase them:

- **The pickers are sticky.** The composer remembers the last model and effort,
  so many picks are whatever was left selected. The same kind of task, such as
  approving a contributor, will show up at low, medium, and high. The deliberate
  signal is where a group is consistent, and where the user moved _away_ from
  their default.
- **Model of the day.** A day spent trying a model puts ordinary tasks on it.
  A model's share swinging between days is that, not routing by task.

Count a few obvious categories (slash commands, PR reviews by link, "mock up",
"fix this issue" with a link, new plugin or app from scratch) per model to see
where the split is real.

## 3. Write the rotation and the instructions

Jev reads literally and does not reason in steps. Write for that:

- Short, concrete sentences. Quote the user's own phrasings as examples
  ("mock up", "is this safe to land?", `/approve-contributor`).
- State the default outright: "X is my default. Pick it unless the task clearly
  matches Y." Give rough shares ("about three in five of my tasks").
- Say what does _not_ decide it, if the history shows that: "The length of the
  prompt does not set the effort."
- Effort usually depends on the model. Say each model's default effort, then
  what moves a task up or down from it.
- Name any level the user never uses: "Never pick max."

Each **rotation note** (at most 600 characters) says when to use that model; Jev
sees it as the option's description. The **model instructions** (at most 4,000
characters) hold the rules for choosing the model and the effort, under two
plain headings, since Jev reads them for both questions.

Save what is there now before replacing it, so the user can go back:

```sh
bb magic-compose rotation get --json > "$BB_THREAD_STORAGE/rotation.before.json"
bb magic-compose preferences get --json > "$BB_THREAD_STORAGE/preferences.before.json"
```

Then apply:

```sh
bb magic-compose rotation set "$(cat rotation.json)"
bb magic-compose preferences set modelInstructions "$(cat model-instructions.txt)"
```

`rotation.json` is a list of
`{"providerId", "model", "note", "reasoningLevel"}`. Take `providerId` and
`model` exactly as `bb provider models <provider-id> --json` spells them.
`reasoningLevel` is only a fallback for a model that offers no choice of effort;
set it to that model's default.

The effort levels Jev may pick are a separate setting, a hard limit rather than
advice. Leave it alone unless the user never uses a level it allows. **Never
turn on `ultra` or `ultracode` unless the user asks for it**: they are costly run
modes, and they start off for that reason. To change the list:

```sh
echo '{"scope":{"reasoningLevels":["low","medium","high","xhigh"]}}' > levels.json
bb plugin rpc call magic-compose scope_set --input-file levels.json
```

## 4. Backtest

This sends the user's past prompts to Jev through their gateway. Tell them so and
get a yes first. Use `--exclude` to keep out anything that should not leave the
machine, such as unreleased product or model names.

```sh
bb magic-compose backtest --days 14 \
  --map '<regex>=<rotation model id>' \
  --exclude '<regex>' --json
```

It routes each distinct past prompt with the current rotation and instructions
and reports, for model and for effort, how often Jev agreed with the user, beside
what always picking their favourite would score, plus confusion tables and up to
80 disagreements. A few hundred prompts take about fifteen seconds and cost well
under a cent.

Read the disagreements before the percentages:

- Where Jev is _consistent_ and the user was not (the same chore at three
  efforts), Jev is following the rule. Leave it.
- Where a whole category goes the wrong way, fix the rule that covers it, with
  one more example in the user's words, and run the backtest again.

Stop after one or two rounds. Agreement well above the favourite-model baseline
is a good result; the sticky pickers cap how high it can go, and rules bent to
fit the noise route new prompts worse. Expect effort to land within one level
far more often than exactly.

## 5. Report

Tell the user, plainly:

- what the rotation and the instructions now say, and that both are ordinary
  settings under Settings → Magic Compose that they can edit;
- the agreement numbers next to the baselines, including any that did not beat
  the baseline, and why the history limits them;
- which judgment calls were yours rather than the history's;
- where the previous settings were saved.

Spot-check a handful of fresh prompts with `bb magic-compose route "<prompt>"`
before you finish. It starts nothing.
