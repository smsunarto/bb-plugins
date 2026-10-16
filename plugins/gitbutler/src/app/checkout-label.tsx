import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

// Match GTD Sidebar's host-ID palette, including its fallbacks for other themes.
const MACHINE_COLORS = [
  "var(--machine-1, color-mix(in oklab, var(--ansi-4) 88%, var(--foreground)))",
  "var(--machine-2, var(--ansi-6))",
  "var(--machine-3, color-mix(in oklab, var(--ansi-5) 88%, var(--foreground)))",
  "var(--machine-4, color-mix(in oklab, var(--ansi-5) 52%, var(--foreground)))",
] as const;

function machineColor(hostId: string): string {
  let hash = 0;
  for (const character of hostId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return MACHINE_COLORS[hash % MACHINE_COLORS.length] ?? MACHINE_COLORS[0];
}

/** Checkout and machine share a row; the full path stays available in the tooltip. */
export function CheckoutLabel({
  path,
  machine,
  hostId,
}: {
  path: string;
  machine: string;
  hostId: string;
}) {
  const name = path.split(/[\\/]/).findLast(Boolean) ?? path;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={path} translate="no">
        {name}
      </span>
      <span
        className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
        title={`${machine} · ${path}`}
      >
        <span
          className="inline-flex shrink-0 items-center"
          style={{ color: machineColor(hostId) }}
          data-machine-id={hostId}
          aria-hidden="true"
        >
          <Icon name="Globe" className="size-3" aria-hidden />
        </span>
        <span className="min-w-0 truncate" title={machine}>
          {machine}
        </span>
      </span>
      <span className="sr-only" translate="no">
        {path}
      </span>
    </span>
  );
}
