# My Stack Constitution

`my-stack` is a personal preference layer over coding agent harnesses. Its
purpose is to help a capable agent understand how its user likes to work.
It is designed for frontier models such as Astra, Fable, and Sol, running in
harnesses such as Codex and Claude Code.

## 1. Trust the model and its harness

Start from the assumption that frontier models can solve problems and that
their harnesses support them well. The labs developing them invest in training
and evaluation that we cannot reproduce for every local prompt change.

Additional instructions have a cost. Prescriptive workflows can compete with
learned behavior, consume context, and limit the model's judgment. Their value
is not established just because they sound rigorous.

My Stack does not teach ordinary engineering competence: debugging, building
features, improving performance, testing, or fixing lint. The model chooses
how to achieve the goal. We add context about the user, rather than a second
implementation process.

## 2. Encode personal taste

General training cannot fully express an individual's preferences. A technically
successful result can still be unpleasant to read, awkward to review, or unlike
what the user wanted. Optimizing a measurable task outcome does not guarantee
personal fit. This is our design premise, not a claim about every lab's training
method or evaluation.

Our artifacts describe **user preferences**. They are not rules, policies,
mandatory workflows, or permission grants. They communicate desired qualities,
tradeoffs, and personal tool choices. A preference should help the model make a
decision, without prescribing the sequence of work.

The user's current request takes precedence over a saved preference. Harness
permissions and higher-priority instructions still apply. When a preference
does not fit the task, the model can use judgment without turning the exception
into an approval ceremony.

## 3. Scope tuning to where it belongs

Preferences inherit through the folder tree: general, then harness, then model.
For Codex running Astra, the applicable scopes are the root, `codex/`, and
`codex/astra/`. Within the current topic, a narrower preference refines its
parents and wins when they conflict. Unrelated preferences remain applicable.

`claude/` means the Claude Code harness. `codex/` means the Codex harness.
The next directory identifies the model family. Provider vendor and harness
are not assumed to be interchangeable: a delegated agent uses its own actual
harness and model scopes. An unknown model inherits known parent scopes,
without guessing a model-specific match.

Model quirks can justify different preferences. Proposed tuning starts as a
trial, not as an established finding about a model. Astra, Fable, Opus, and Sol
are readable family names here, not a pinned catalog of API model identifiers.

## 4. Keep preferences small and editable

The living folder is `~/.agents/preferences`. A descriptive filename should
make a preference's subject obvious without opening it. Each Markdown file
contains one coherent preference, short discovery metadata, and a self-contained
body. Humans and agents can curate the same files directly.

Use the narrowest justified scope. Shared taste belongs at the root, even if
the correction was first observed with one model. A model directory can stay
absent until there is a useful preference to put there.

Write short, imperative preference statements and use examples that clarify
them. Imperative wording expresses the user's taste without making it a
mandatory rule. Avoid turning every correction into a universal instruction,
accumulating procedural manuals, or copying the same preference into multiple
harnesses. Keep evidence and
curation notes separate from the text an agent needs for its task.

## 5. Let native skill discovery route attention

Harnesses already discover skills through their names and descriptions. Use
that mechanism. A `/my-…-way` skill is a small routing index for a topic, such as
communication, Go, demos, or design.

Each preference's frontmatter owns its way and discovery description. A way's
description is a concise aggregation of those authored triggers. Its body only
names the preference files to read and the conditions under which they apply.
It does not contain the preferences themselves, choose an implementation plan,
invoke a chain of other ways, or preload the entire preference tree.

Arbitrary Markdown frontmatter is not automatically advertised by a harness.
An agent can read it once the file is open. The routing skill bridges discovery,
not a file-reading limitation.

For this prototype, the preference files and way indexes are written by hand.
Future maintenance can help curate and index them, but it should preserve the
triggers authored in preferences and the model's freedom to choose its work.
