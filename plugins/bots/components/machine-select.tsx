import { useId } from "react";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function MachineSelect({
  hosts,
  value,
  onValueChange,
  disabled = false,
  connectedOnly = false,
  label = "Machine",
  hideLabel = false,
}: {
  hosts: { id: string; name: string; connected: boolean }[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  connectedOnly?: boolean;
  label?: string;
  /** The caller shows its own visible label; keep this one for screen readers. */
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className={hideLabel ? "sr-only" : "text-muted-foreground"}>
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} className="h-8 text-xs">
          <SelectValue placeholder="Select machine" />
        </SelectTrigger>
        <SelectContent>
          {value && !hosts.some((host) => host.id === value) ? (
            <SelectItem value={value} disabled>
              Unavailable machine ({value})
            </SelectItem>
          ) : null}
          {hosts.map((host) => (
            <SelectItem key={host.id} value={host.id} disabled={connectedOnly && !host.connected}>
              {host.name}
              {host.connected ? "" : " (offline)"}
            </SelectItem>
          ))}
          {!hosts.length && !value ? (
            <SelectItem value="__unavailable__" disabled>
              No machines available
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}
