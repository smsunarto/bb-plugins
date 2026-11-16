import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorMessage } from "../../shared/errors.js";

const COLOR_PALETTE = [
  { value: "slateblue", label: "Indigo" },
  { value: "steelblue", label: "Blue" },
  { value: "lightseagreen", label: "Teal" },
  { value: "mediumseagreen", label: "Green" },
  { value: "goldenrod", label: "Yellow" },
  { value: "sandybrown", label: "Orange" },
  { value: "indianred", label: "Red" },
  { value: "palevioletred", label: "Pink" },
  { value: "mediumpurple", label: "Purple" },
  { value: "slategray", label: "Gray" },
] as const;

export const DEFAULT_COLOR = COLOR_PALETTE[0].value;

export function derivePrefix(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const raw =
    words.length >= 2 ? words.map((word) => word[0]).join("") : (words[0] ?? "").slice(0, 3);
  return raw.replace(/^[0-9]+/, "").slice(0, 10);
}

export function describeCreateProjectError(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("UNIQUE") && message.includes("prefix")) {
    return "That prefix is already used by another project.";
  }
  return message;
}

export function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label="Color"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      className="flex-wrap justify-start gap-2"
    >
      {COLOR_PALETTE.map((swatch) => (
        <ToggleGroupItem
          key={swatch.value}
          value={swatch.value}
          aria-label={swatch.label}
          title={swatch.label}
          className="size-5 min-w-0 rounded-md p-0 data-[state=on]:ring-2 data-[state=on]:ring-ring data-[state=on]:ring-offset-2 data-[state=on]:ring-offset-background"
          style={{ backgroundColor: swatch.value }}
        />
      ))}
    </ToggleGroup>
  );
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  /** The id of the control the label names, when the control is labelable. */
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
