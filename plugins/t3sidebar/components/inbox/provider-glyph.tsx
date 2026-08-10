// oxlint-disable jsx-a11y/prefer-tag-over-role -- the rule wants `<img>`, but
// these are inline `<svg>` paths and a CSS-drawn dot; `role="img"` with an
// `aria-label` is the correct pattern for both and `<img>` cannot express them.
import { useState } from "react";
import { cn } from "@/lib/utils";
import { TRAILING_GLYPH_BOX_CLASS } from "@/components/inbox/status-slot";
import { providerMark } from "@/lib/provider-marks";

export interface ProviderGlyphInfo {
  displayName: string;
  logoUrl: string | null;
}

/**
 * The agent a thread runs on, drawn by this plugin.
 *
 * Always rendered, so the card's third line has a fixed right edge even when a
 * thread has no branch. Three sources, in order: a logo the host serves, the
 * mark this plugin carries for an agent BB knows, then a neutral dot for an
 * unknown provider — `providerId` is a free-form id, so that last case is
 * ordinary rather than exceptional.
 *
 * The host logo wins so that a plugin-supplied ACP agent shows its own brand,
 * and so this plugin's copies retire on their own if BB ever serves marks for
 * the agents it ships.
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
  // A logo that fails to load must fall through to the marks below rather than
  // leave a broken image in a fixed-width slot.
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const box = cn(TRAILING_GLYPH_BOX_CLASS, className);
  const logoUrl = provider?.logoUrl ?? null;
  const displayName = provider?.displayName ?? providerId;

  if (logoUrl !== null && logoUrl !== failedLogoUrl) {
    return (
      <span role="img" aria-label={displayName} className={box}>
        <img
          src={logoUrl}
          alt=""
          className="size-3 object-contain"
          onError={() => setFailedLogoUrl(logoUrl)}
        />
      </span>
    );
  }

  const mark = providerMark(providerId);
  if (mark !== undefined) {
    return (
      <span className={box}>
        <svg
          viewBox={mark.viewBox}
          fill="currentColor"
          fillRule={mark.fillRule}
          role="img"
          aria-label={displayName}
          className="size-3 text-muted-foreground/70"
        >
          {mark.paths.map((path) => (
            <path key={path.d} d={path.d} fillOpacity={path.fillOpacity} />
          ))}
        </svg>
      </span>
    );
  }

  return (
    <span role="img" aria-label={displayName} className={box}>
      <span className="size-2 rounded-full bg-muted-foreground/50" />
    </span>
  );
}
