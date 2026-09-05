# Title heuristics

[Plan overview](overview.md)

## Confirmed preferences

| Rule                                  | Example or implication                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Track the current substantive task    | A Cloudflare setup thread can become title-quality work.               |
| Track the supported activity or phase | Verification, review, readiness, and shipment have different meanings. |
| Put the emoji before the scope        | `🧪 [GTD Sidebar] Title accuracy vs cost`                              |
| Put scope before task                 | `[GTD Sidebar] Waiting sort fix`                                       |
| Never use the repository as scope     | Repository identity is already in the UI.                              |
| Keep distinguishing detail            | Prefer `Title accuracy vs cost` to `Naming eval`.                      |
| Put important nouns early             | `Namespace CLI install via mise`                                       |
| Preserve question intent              | `[Monaco] Can TextMate work?`                                          |
| Preserve multiple substantive scopes  | `🐛 [GTD + Vimium] Sort & focus fixes`                                 |
| Use concise language                  | Brevity and clarity matter more than complete grammar.                 |

Treat spelling corrections, acknowledgments, retries, and `continue` as steering within the current task unless supplied context establishes a task change. Do not let the title drift to generic phrases such as `Continue implementation` or `Summarize each role`.

The acknowledgment rule is a proposed operational default derived from the substantive-task preference. A phase change can still require a rename. A completed older subtask should not displace a newer user request.

## Activity vocabulary

| Activity                   | Emoji | Status                           |
| -------------------------- | ----- | -------------------------------- |
| Exploration or question    | None  | Explicitly confirmed             |
| Code review                | 🔎    | Explicitly confirmed             |
| Refactor                   | ♻️    | Confirmed as a distinct activity |
| Ready to ship              | 🚀    | Explicitly confirmed             |
| Shipped after `ship it`    | ☑️    | Explicitly confirmed             |
| Planning                   | 📝    | Proposed default                 |
| Implementation             | 🛠️    | Proposed default                 |
| Bug fix                    | 🐛    | Proposed default                 |
| Verification or evaluation | 🧪    | Proposed default                 |
| Installation               | 📦    | Proposed default                 |
| Configuration              | ⚙️    | Proposed default                 |

Use one activity emoji at most. Do not add a text activity tag when the emoji carries it, unless an action word adds necessary meaning. Exploration has no replacement emoji. 🔎 must not mean exploration.

☑️ requires both an explicit user `ship it` request and supplied evidence that shipping succeeded for the same task. Quoted examples, receiving the request, an attempted push, or generic completion are insufficient. Do not silently broaden the trigger to other phrases. A failed or interrupted shipping attempt cannot earn ☑️. A new substantive task removes the old shipment state.

🚀 requires supplied evidence of readiness. A hypothetical suggestion to ship later is insufficient. When activity is uncertain, omit an unsupported emoji rather than invent progress.

## Scope rules

Repository-specific setup should identify stable product areas the user recognizes. Prefer canonical display names, with only deliberate compact aliases. `[GTD + Vimium]` demonstrates that a known alias can preserve two scopes.

Do not mechanically prefix every title. Repository-wide or unclear work can omit a scope. Mentioning a dependency, directory, or plugin does not establish substantive ownership. A new scope absent from the rule file must have evidence in supplied context or remain omitted.

The primary subject still needs to survive after scope selection. A title consisting only of an emoji and scope fails even if it fits the width. More than two substantive scopes should use a supported common area when available, otherwise a concise task description. This is a proposed fallback to test, not an additional confirmed preference.

## Length and uncertainty

No numeric title limit was chosen in the interview. Evaluate 48- and 64-grapheme candidates at real sidebar widths. Keep a generous defensive storage bound, proposed at 96 graphemes, separate from the preferred visual length. Freeze the chosen limits before the held-out evaluation.

Prefer a short grounded title to a precise-looking guess. Preserve question marks. Avoid unsupported file names, causality, implementation promises, readiness, and shipment claims.

Use multiple-choice examples for any remaining preference calibration. Ask one question at a time, with at most three choices. Do not reopen preferences already confirmed above.
