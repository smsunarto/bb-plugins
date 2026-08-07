# feat(acp): let agents supply their own reasoning levels

**Environment:** bb 0.35.1, macOS. Custom ACP provider via `customAcpAgents`.

## Summary

I'm writing a bb plugin that registers [Amp](https://ampcode.com) as an ACP provider. Amp has no reasoning-effort setting: it picks model and effort from the selected mode, and its CLI has no `--effort` flag.

bb shows a **Reasoning** picker for every ACP provider anyway, with no way for an agent to say it doesn't have one. Users get a control that looks real and does nothing.

The UI is willing to hide it. `ModelReasoningPicker.tsx` gates on `activeReasoningOptions.length > 0`, and `useThreadCreationOptions.ts` returns `[]` when there are no efforts. The row survives because the ACP catalog layer never lets the list be empty.

## Why the list is never empty

`packages/agent-runtime/src/acp/bridge/model-catalog.ts` defines one fallback entry:

```ts
export const ACP_NATIVE_REASONING_EFFORTS: AvailableModel["supportedReasoningEfforts"] = [
  { reasoningEffort: "medium", description: "Reasoning effort is managed by the connected ACP agent." },
];
```

and substitutes it at four points:

- `buildAcpNativeReasoningSupport`, when `thought_level` is absent or no value maps to a `ReasoningLevel`
- `buildModelCatalogFromConfigOptions`, per model, when `reasoningByModel` has no entry
- `buildModelCatalogFromSessionModels`, unconditionally
- `bridge.ts`, on the synthetic `ACP_DEFAULT_MODEL` it invents when an agent advertises no models

It's the floor of every path, so no configuration reaches an empty list.

Sending the option doesn't help either. Values must map through `acpNativeValueToReasoningLevel` or they're skipped, and an all-skipped list hits the fallback. Labels come from `REASONING_LABELS`, keyed by level; `buildAcpNativeReasoningSupport` does carry the agent's `option.name` into `description`, but nothing renders it.

So the only choice is which of bb's eight levels to show, and all eight are wrong. `Medium` claims an effort Amp was never given; `None` says reasoning is off when it isn't. The fallback's own description says the true thing and never appears.

## Proposals

**Let agents supply their own levels.** Pass `option.value` and `option.name` through instead of mapping them to `ReasoningLevel` and `REASONING_LABELS`. bb already receives both and throws them away.

That makes the row useful for Amp. Its modes are `low`, `medium`, `high`, `ultra`, and each selects a pair of models: the agent model, and the Oracle it escalates to. Right now I pack that pair into the model picker's `displayName` (`Medium (GPT 5.6 Sol · GPT 5.6 Sol)`) because it's the one string bb prints verbatim. With custom levels the mode axis moves to the Reasoning row, where it reads naturally, and the picker can show models.

It's a stretch and I know it — Amp's mode bundles model choice with effort, so filing it under reasoning isn't quite honest. But it's a general capability, useful to any agent whose effort axis doesn't match bb's eight, and I'd rather overload an existing axis than ask for a flag only Amp will ever set.

**Or let agents opt out.** Treat `thought_level` present with `options: []` as "no reasoning control" and skip the fallback, so the existing gate hides the row. `acpConfigOptionSchema` already allows an empty array, so nothing changes on the wire, and requiring the option to be present keeps today's behaviour for agents that send no config options. Narrower, and it hides the row instead of making it worth having.

## Smaller, related

The two catalog builders disagree about descriptions. `buildModelCatalogFromSessionModels` passes `model.description` through; `buildModelCatalogFromConfigOptions` hardcodes `""`. The gap starts in `wire.ts` — `acpSessionModelSchema` declares `description`, `acpConfigOptionSelectOptionSchema` doesn't. Amp sends one per mode and it survives only as a passthrough key. Adding the field and reading it would let providers explain their modes.
