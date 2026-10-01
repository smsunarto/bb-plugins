import { useId } from "react";
import type { TweakControl, TweakGroup } from "./tweak-contract.ts";

export function TweakPanel({
  groups,
  original,
  onChange,
  onReset,
  onOriginal,
  onApply,
  onClose,
  saving,
  readOnly,
}: {
  groups: TweakGroup[];
  original: boolean;
  onChange: (groupId: string, controlId: string, value: string | number | boolean) => void;
  onReset: (groupId?: string) => void;
  onOriginal: (active: boolean) => void;
  onApply: () => void;
  onClose: () => void;
  saving: boolean;
  readOnly: boolean;
}) {
  return (
    <aside className="inline-vis-tweaks" aria-label="Design controls">
      <div className="inline-vis-tweak-heading">
        <h3>Tweak</h3>
        <button type="button" onClick={onClose} aria-label="Close Tweak panel">
          ×
        </button>
      </div>
      <p>Adjust the preview, then add your changes to chat.</p>
      <div className="inline-vis-tweak-actions">
        <button type="button" aria-pressed={original} onClick={() => onOriginal(!original)}>
          {original ? "Show edits" : "Show original"}
        </button>
        <button type="button" onClick={() => onReset()}>
          Reset all
        </button>
      </div>
      {groups
        .filter((group) => group.visible)
        .map((group) => (
          <fieldset key={group.id} disabled={original}>
            <legend>
              {group.title}
              {group.variant ? ` · ${group.variant}` : ""}
            </legend>
            {group.controls.map((control) => (
              <DesignControl
                key={control.id}
                control={control}
                onChange={(value) => onChange(group.id, control.id, value)}
              />
            ))}
            <button
              type="button"
              className="inline-vis-tweak-reset"
              onClick={() => onReset(group.id)}
            >
              Reset {group.title}
            </button>
          </fieldset>
        ))}
      {!groups.some((group) => group.visible) && <p>No controls for this design.</p>}
      <button
        type="button"
        className="inline-vis-tweak-apply"
        disabled={original || saving || readOnly}
        onClick={onApply}
      >
        {saving ? "Saving…" : "Add changes to chat"}
      </button>
    </aside>
  );
}

function DesignControl({
  control,
  onChange,
}: {
  control: TweakControl;
  onChange: (value: string | number | boolean) => void;
}) {
  const id = useId();
  return (
    <div className="inline-vis-tweak-control">
      <label htmlFor={id}>
        <span>{control.label}</span>
        {control.type === "slider" && (
          <output aria-hidden="true" htmlFor={id}>
            {control.value}
            {control.unit ?? ""}
          </output>
        )}
      </label>
      {control.reference && <small>{control.reference}</small>}
      {control.type === "slider" ? (
        <input
          id={id}
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={control.value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      ) : control.type === "color" ? (
        <input
          id={id}
          type="color"
          value={control.value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : control.type === "toggle" ? (
        <input
          id={id}
          type="checkbox"
          checked={control.value}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : (
        <select id={id} value={control.value} onChange={(event) => onChange(event.target.value)}>
          {control.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
