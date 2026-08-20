// oxlint-disable jsx-a11y/prefer-tag-over-role -- the rule wants `<img>`, but
// these are inline `<svg>` paths, a CSS mask and a CSS-drawn dot; `role="img"`
// with an `aria-label` is the correct pattern and `<img>` cannot express them.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { TRAILING_GLYPH_BOX_CLASS } from "@/components/inbox/status-slot";
import { providerMark } from "@/lib/provider-marks";

export interface ProviderGlyphInfo {
  displayName: string;
  logoUrl: string | null;
}

/** One tint for every glyph, so the trailing column reads as one column. */
const GLYPH_TINT = "size-3 text-muted-foreground/70";

/**
 * The agent a thread runs on, drawn by this plugin.
 *
 * Always rendered, so the card's third line has a fixed right edge even when a
 * thread has no branch. Three sources, in order: a logo the host serves, the
 * mark this plugin carries for an agent BB knows, then a neutral dot for an
 * unknown provider — `providerId` is a free-form id, so that last case is
 * ordinary rather than exceptional.
 *
 * The host logo wins so that a plugin-supplied ACP agent shows its own artwork,
 * and so this plugin's copies retire on their own if BB ever serves marks for
 * the agents it ships.
 *
 * A host logo is drawn as a CSS mask rather than an `<img>`, so it takes the
 * same muted tint as every other glyph instead of arriving in its own brand
 * colour — Amp's mark is a saturated red that would be the only colour in the
 * column. The trade is that a multi-colour logo becomes a silhouette, which is
 * the right way round for a 12px glyph in a fixed-width slot.
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
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const box = cn(TRAILING_GLYPH_BOX_CLASS, className);
  const displayName = provider?.displayName ?? providerId;
  const logoUrl = provider?.logoUrl ?? null;
  const maskedLogoUrl = logoUrl === failedLogoUrl ? null : logoUrl;

  // A mask reports nothing when its URL fails: it just paints an empty box.
  // Probing the image keeps a broken logo falling through to the marks below
  // rather than leaving a hole in a slot that is always the same width.
  useEffect(() => {
    if (maskedLogoUrl === null) return;
    const probe = new Image();
    const onError = () => setFailedLogoUrl(maskedLogoUrl);
    probe.addEventListener("error", onError);
    probe.src = maskedLogoUrl;
    return () => probe.removeEventListener("error", onError);
  }, [maskedLogoUrl]);

  if (maskedLogoUrl !== null) {
    const mask = {
      maskImage: `url("${maskedLogoUrl}")`,
      maskPosition: "center",
      maskRepeat: "no-repeat",
      maskSize: "contain",
      WebkitMaskImage: `url("${maskedLogoUrl}")`,
      WebkitMaskPosition: "center",
      WebkitMaskRepeat: "no-repeat",
      WebkitMaskSize: "contain",
    };
    return (
      <span role="img" aria-label={displayName} className={box}>
        <span className="size-3 bg-muted-foreground/70" style={mask} />
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
          className={GLYPH_TINT}
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
