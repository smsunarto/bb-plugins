import {
  experimental_ProviderIcon as ProviderIcon,
  type ExperimentalProviderIconProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { TRAILING_GLYPH_BOX_CLASS } from "./status-slot";

export type ProviderGlyphInfo = Pick<
  ExperimentalProviderIconProps["provider"],
  "logoUrl" | "icon"
> & { displayName: string };

/**
 * The agent a thread runs on, drawn with bb's own provider artwork.
 *
 * Always rendered, so the card's third line has a fixed right edge even when a
 * thread has no branch. bb resolves a plugin's icon override, then the served
 * logo, then the agent's glyph, then a fallback, so a provider id bb has never
 * heard of still gets a mark.
 *
 * The record goes in without `strings`, which is where bb reads a brand tint:
 * every glyph takes the same muted colour, so Amp's saturated red does not
 * become the only colour in the column. Logos already render as
 * `currentColor` masks.
 */
export function ProviderGlyph({
  providerId,
  provider,
  className,
}: {
  providerId: string;
  provider?: ProviderGlyphInfo;
  className?: string;
}) {
  return (
    <span className={cn(TRAILING_GLYPH_BOX_CLASS, className)}>
      <ProviderIcon
        providerKind="agent"
        provider={{ id: providerId, logoUrl: provider?.logoUrl, icon: provider?.icon }}
        aria-label={provider?.displayName ?? providerId}
        className="size-3 text-muted-foreground/70"
      />
    </span>
  );
}
