import { useCommandState } from "cmdk";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";

/** Offers to create the typed label once the query matches no existing label. */
export function CreateLabelItem({
  name,
  disabled,
  onCreate,
}: {
  name: string;
  disabled: boolean;
  onCreate: () => void;
}) {
  // A force-mounted item is not counted in the filter, so showing this one keeps the count at 0.
  const nothingMatches = useCommandState((state) => state.filtered.count === 0);
  if (name === "" || !nothingMatches) return null;
  return (
    <CommandGroup forceMount>
      <CommandItem forceMount value={`create:${name}`} disabled={disabled} onSelect={onCreate}>
        <Icon name="Plus" className="size-3.5" />
        Create “{name}”
      </CommandItem>
    </CommandGroup>
  );
}
