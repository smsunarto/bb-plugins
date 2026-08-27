// A leaf on purpose: production bb loads a path-installed plugin's server.ts
// from source, and its runtime shim cannot resolve @get-bb/plugin-sdk
// subpaths, so everything server.ts reaches must stay off them.

/** Amp has no per-thread model choice: the mode (`--mode`) selects the model,
 *  system prompt, and tool selection. The catalog is therefore one model whose
 *  reasoning efforts are the four Amp modes; `src/bridge/options.ts` maps the
 *  selected level onto `--mode`. Served twice — as the declaration's
 *  cold-cache fallback and as the bridge's live `model/list` answer. The live
 *  answer replaces the fallback wholesale, so both read this one constant. */
export const AMP_MODEL_ID = "amp";

export const AMP_FALLBACK_MODELS = [
  {
    id: AMP_MODEL_ID,
    displayName: "Amp",
    description:
      "The reasoning level selects the Amp mode, which controls the model, system prompt, and tool selection.",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Amp's low mode." },
      { reasoningEffort: "medium", description: "Amp's medium mode." },
      { reasoningEffort: "high", description: "Amp's high mode." },
      { reasoningEffort: "ultra", description: "Amp's ultra mode." },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
] as const;

/** The daemon's `model/list` result schema additionally requires `model`, the
 *  raw provider model string; bb's own fallback projection fills it with the
 *  id, and so does this. */
export const AMP_WIRE_MODELS = AMP_FALLBACK_MODELS.map((entry) =>
  Object.assign({}, entry, { model: entry.id }),
);
