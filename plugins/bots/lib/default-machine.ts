export const BOT_MACHINE_SETTINGS = {
  defaultMachine: {
    type: "string",
    label: "Default machine",
    description:
      "Name or ID of the machine new bots run on, such as Dev PC. Leave empty to use the first connected machine.",
    default: "",
  },
} as const;

/** The enrolled machine a configured name or ID names: ID first, then case-insensitive name. */
export function matchDefaultMachine<Host extends { id: string; name: string }>(
  hosts: readonly Host[],
  configured: unknown,
): Host | null {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (!value) return null;
  const name = value.toLowerCase();
  return (
    hosts.find((host) => host.id === value) ??
    hosts.find((host) => host.name.trim().toLowerCase() === name) ??
    null
  );
}
