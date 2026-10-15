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
  { id: "precise-edit", label: "Precise edit", provider: "GPT Image 2", billing: "plan" },
  { id: "model-3d", label: "3D model", provider: "Tripo P2", billing: "paid" },
  { id: "voice-sfx", label: "Voice/SFX", provider: "ElevenLabs", billing: "paid" },
  { id: "music", label: "Music", provider: "Suno", billing: "plan" },
];

export function GenerationOptions({
  kind,
  hasImageReference,
  disabled,
  onSend,
}: {
  kind: NodeKind;
  hasImageReference: boolean;
  disabled: boolean;
  onSend: (recipe: GenerationRecipe) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [recipe, setRecipe] = useState<GenerationRecipe>(
    kind === "model-3d" ? "model-3d" : kind === "asset" ? "voice-sfx" : "concept-art",
  );
  const blocked = disabled || (recipe === "model-3d" && !hasImageReference);
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
            {recipes.map((option) => {
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
                    {needsImage && <small>Needs an approved image</small>}
                  </span>
                  <span className="gs-generation-badge">{option.billing}</span>
                </label>
              );
            })}
          </fieldset>
          <footer>
            <span>1 output · sent to agent thread</span>
            <button
              type="button"
              className="gs-primary"
              disabled={blocked}
              onClick={() => onSend(recipe)}
            >
              Send to agent
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
