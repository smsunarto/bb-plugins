# ACP providers: let an agent declare that it has no reasoning control

> **Update, 2026-08-08:** The pinned Amp SDK now supports explicit `--effort`
> overrides. Amp still has a distinct omitted/default state in which the chosen
> mode owns effort. bb cannot represent that state alongside explicit ACP
> `thought_level` values: an unknown `default` sentinel is dropped, while a
> recognized current value can be sent back as an override. The bridge
> therefore continues to omit `thought_level` to preserve Amp's mode defaults.
> The original report below is retained as historical context for bb's fallback
> Reasoning row.

**Environment:** bb 0.35.1, macOS. Custom ACP provider registered via `customAcpAgents`.

## Summary

I'm writing a bb plugin that registers [Amp](https://ampcode.com) as an ACP provider. Amp has no per-request reasoning-effort setting — it derives both the model and its effort from the selected agent mode, and its CLI has no `--effort` flag at all.

bb always shows a **Reasoning** control for ACP providers, and an agent has no way to say "I don't have this setting". The user gets a picker that looks like a setting but changes nothing.

The UI is already willing to hide the section — `ModelReasoningPicker.tsx` gates it on `activeReasoningOptions.length > 0`, and `useThreadCreationOptions.ts` returns `[]` when there are no efforts. The section survives only because the ACP catalog layer always injects a non-empty list.

## Where it comes from

`packages/agent-runtime/src/acp/bridge/model-catalog.ts`:

```ts
export const ACP_NATIVE_REASONING_EFFORTS: AvailableModel["supportedReasoningEfforts"] = [
  { reasoningEffort: "medium", description: "Reasoning effort is managed by the connected ACP agent." },
];
```

It is substituted at three points, so no ACP agent can ever produce an empty list:

- `buildAcpNativeReasoningSupport` — when the `thought_level` option is absent or none of its values map to a `ReasoningLevel`.
- `buildModelCatalogFromConfigOptions` — per model, when there is no entry in `reasoningByModel`.
- `buildModelCatalogFromSessionModels` — unconditionally.

Supplying the option instead doesn't express "not applicable" either:

- **Values** must map through `acpNativeValueToReasoningLevel`; unmapped values are skipped, and if all are skipped the fallback applies.
- **Labels** are looked up by level in `apps/app/src/lib/reasoning-labels.ts` (`REASONING_LABELS`), used by both `useThreadCreationOptions.ts` and `ModelReasoningPicker.tsx`. The agent's `option.name` reaches `supportedReasoningEfforts[].description` in `buildAcpNativeReasoningSupport`, but neither call site renders `description` — both use `REASONING_LABELS[effort.reasoningEffort]`.

So the only real choice is *which* of the eight built-in levels to display. For an agent with no reasoning setting every option is wrong: `Medium` implies a level Amp was never given, `None` implies reasoning is off when it isn't.

The fallback's own description — *"Reasoning effort is managed by the connected ACP agent."* — states the correct thing. It's just never shown.

## Proposals

Any one of these unblocks it; roughly in order of preference.

1. **Let an agent opt out explicitly.** Treat a `thought_level` option that is present with `options: []` as "no reasoning control" and skip the fallback, so `supportedReasoningEfforts` stays empty and the existing `showReasoningSection` gate hides the row. Explicit-empty preserves today's behaviour for agents that simply don't implement config options.
2. **Render the description instead of a picker.** When the efforts are `ACP_NATIVE_REASONING_EFFORTS`, show that sentence as static text rather than a selectable "Medium". No protocol change, and the copy already exists.
3. **Render the agent's `description`** for reasoning entries in the two call sites, falling back to `REASONING_LABELS`. That would also let agents label what a level means for them.

## Smaller, related

`buildModelCatalogFromConfigOptions` hardcodes `description: ""` for every model, while `buildModelCatalogFromSessionModels` passes `model.description ?? ""` through. Threading `option.description` in the configOptions path too would let providers explain their modes in the picker, and would make the two paths consistent.

## Repro

1. Register any ACP agent under `customAcpAgents`.
2. Have `session/new` return a `category: "model"` config option and **no** `thought_level` option.
3. Open the model picker — a **Reasoning** section appears with a single selectable "Medium".
4. Selecting it changes nothing: the agent is never told, and has nothing to apply.

## Note

`splitModelLabelTag`'s trailing-parenthesis convention is lovely — I'm using it to surface Amp's underlying models as `Medium (GPT 5.6 Sol · GPT 5.6 Sol)`, the same way Claude Code renders `Opus 5 (1M)`. The reasoning row is the last piece I can't represent honestly.

I'm happy to send a PR for option 1 or 2 if you'd like.
