import { useId, useState } from "react";
import type { GenerationRecipe, NodeKind } from "../shared/schema.ts";
import "./generation.css";

const recipes: {
  id: GenerationRecipe;
  label: string;
  provider: string;
  billing: "plan" | "paid";
}[] = [
  { id: "concept-art", label: "Concept art", provider: "Midjourney", billing: "plan" },
  { id: "nano-banana", label: "Image / edit", provider: "Nano Banana 2.1", billing: "paid" },
  { id: "omni-video", label: "Video", provider: "Gemini Omni", billing: "paid" },
  { id: "fal-video", label: "Video", provider: "Fal H3 Max", billing: "paid" },
  { id: "model-3d", label: "3D model", provider: "Tripo P2", billing: "paid" },
  { id: "voice-sfx", label: "Voice/SFX", provider: "ElevenLabs", billing: "paid" },
  { id: "music", label: "Music", provider: "Suno", billing: "plan" },
];

export function GenerationOptions({
  kind,
  hasImageReference,
  disabled,
  onSend,
  onGenerate,
  busy = false,
}: {
  kind: NodeKind;
  hasImageReference: boolean;
  disabled: boolean;
  onSend: (recipe: GenerationRecipe) => void;
  onGenerate?: (recipe: GenerationRecipe) => void;
  busy?: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [recipe, setRecipe] = useState<GenerationRecipe>(
    kind === "model-3d"
      ? "model-3d"
      : kind === "asset"
        ? "voice-sfx"
        : kind === "video"
          ? "omni-video"
          : "nano-banana",
  );
  const visibleRecipes = recipes.filter((option) => {
    if (kind === "video") return ["omni-video", "fal-video"].includes(option.id);
    if (kind === "model-3d") return option.id === "model-3d";
    if (kind === "asset") return ["voice-sfx", "music"].includes(option.id);
    return ["nano-banana", "concept-art"].includes(option.id);
  });
  const blocked = disabled || busy || (recipe === "model-3d" && !hasImageReference);
  return (
    <div className="gs-generation">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        onClick={() => setExpanded((current) => !current)}
      >
        Generate <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
      </button>
      {expanded && (
        <div id={id} className="gs-generation-options">
          <fieldset>
            <legend>Generate</legend>
            {visibleRecipes.map((option) => {
              const needsImage = option.id === "model-3d" && !hasImageReference;
              return (
                <label
                  key={option.id}
                  className="gs-generation-option"
                  data-disabled={needsImage || undefined}
                >
                  <input
                    type="radio"
                    name={`${id}-recipe`}
                    value={option.id}
                    checked={recipe === option.id}
                    disabled={needsImage}
                    onChange={() => setRecipe(option.id)}
                  />
                  <span>
                    <span className="gs-generation-label">
                      {option.label} <span aria-hidden="true">·</span> {option.provider}
                    </span>
                    {needsImage && <small>Connect an image reference first</small>}
                  </span>
                  <span className="gs-generation-badge">{option.billing}</span>
                </label>
              );
            })}
          </fieldset>
          {recipe === "model-3d" && (
            <p className="gs-muted">
              Tripo uses one approved image. The brief guides review; change the source image to
              change the model.
            </p>
          )}
          <footer>
            <span>
              {recipe === "concept-art" ? "4 candidates" : "1 output"} ·{" "}
              {onGenerate ? "generated on canvas" : "review in composer"}
            </span>
            <button
              type="button"
              className="gs-primary"
              disabled={blocked}
              onClick={() => (onGenerate ?? onSend)(recipe)}
            >
              {busy ? "Generating…" : onGenerate ? "Generate image" : "Prepare request"}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
