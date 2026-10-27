import { useEffect, useState, type ReactNode } from "react";
import type { ChangedFile, Comparison, ComparisonSide, FileBlobs } from "../../shared/schema.ts";
import { blobUrl } from "../../shared/blob-url.ts";
import { CONTROL_HOVER_TRANSITION } from "../components/ui/motion.ts";
import { bytesDelta, formatBytes, shortSha } from "../format.ts";
import { cn } from "../lib/utils.ts";

/** Each side's file, or null where the change has none: an added file's base, a deleted one's head. */
export type SideUrls = Record<ComparisonSide, string | null>;

export const SIDE_LABEL: Readonly<Record<ComparisonSide, string>> = {
  base: "Before",
  head: "After",
};

/** Where each side's bytes are read, by what the descriptors say is there. */
export function sideUrls(
  pluginId: string,
  comparison: Comparison,
  file: Pick<ChangedFile, "path" | "previousPath">,
  blobs: FileBlobs,
): SideUrls {
  const url = (side: ComparisonSide, path: string) =>
    blobs[side].kind === "blob" ? blobUrl(pluginId, comparison, side, path) : null;
  return { base: url("base", file.previousPath ?? file.path), head: url("head", file.path) };
}

/** The bytes a side holds: an LFS object's own size, not its pointer's. */
export function sideBytes(blobs: FileBlobs, side: ComparisonSide): number | null {
  const blob = blobs[side];
  return blob.kind === "blob" ? (blob.lfs?.size ?? blob.size) : null;
}

/**
 * Why a side's element failed to load. An `<img>` or `<video>` reports only
 * that it failed, so the server's reason is read once, on failure.
 */
export function useLoadFailure(url: string | null, failed: boolean): string | null {
  const [reason, setReason] = useState<{ url: string; text: string } | null>(null);
  useEffect(() => {
    if (!failed || !url) return;
    const controller = new AbortController();
    void (async () => {
      let text = "The browser could not show this file.";
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok)
          text = (await response.text()) || `The server answered ${response.status}.`;
        else await response.body?.cancel();
      } catch {
        if (controller.signal.aborted) return;
        text = "The file could not be read. The server may be unreachable.";
      }
      setReason({ url, text });
    })();
    return () => controller.abort();
  }, [url, failed]);
  return failed && reason?.url === url ? reason.text : failed ? "Loading why it failed…" : null;
}

/** A row of mutually exclusive buttons, such as the image modes. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      // A row of toggle buttons is a group, not a form's fieldset.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="group"
      aria-label={label}
      className="inline-flex rounded-md border border-border p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={cn(
            "h-5.5 cursor-pointer rounded-[4px] px-2 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-selected aria-pressed:text-foreground",
            CONTROL_HOVER_TRANSITION,
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A side's caption: Before or After, then what it measures. */
export function SideCaption({ side, children }: { side: ComparisonSide; children?: ReactNode }) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
      <span
        className={cn("font-medium", side === "base" ? "text-diff-removed" : "text-diff-added")}
      >
        {SIDE_LABEL[side]}
      </span>
      {children}
    </p>
  );
}

/** How the stored bytes changed, and the Git LFS objects behind them. */
export function StorageFacts({ blobs }: { blobs: FileBlobs }) {
  const before = sideBytes(blobs, "base");
  const after = sideBytes(blobs, "head");
  const lfs = (["base", "head"] as const).flatMap((side) => {
    const blob = blobs[side];
    return blob.kind === "blob" && blob.lfs ? [{ side, oid: blob.lfs.oid }] : [];
  });
  const delta = before !== null && after !== null ? bytesDelta(before, after) : null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
      {before !== null && after !== null ? (
        <span>
          {formatBytes(before)} → {formatBytes(after)}
          {delta ? <span className="ms-1.5">({delta})</span> : null}
        </span>
      ) : (
        // An added or deleted file has one size; the card's header says which.
        <span>{formatBytes(after ?? before ?? 0)}</span>
      )}
      {lfs.length ? (
        <span title={lfs.map(({ side, oid }) => `${SIDE_LABEL[side]}: sha256:${oid}`).join("\n")}>
          Stored with Git LFS ·{" "}
          {lfs
            .map(({ side, oid }) => `${SIDE_LABEL[side].toLowerCase()} ${shortSha(oid)}`)
            .join(", ")}
        </span>
      ) : null}
    </p>
  );
}

/** Download links for each side, for a file no preview draws. */
export function DownloadLinks({ urls, name }: { urls: SideUrls; name: string }) {
  const links = (["base", "head"] as const).flatMap((side) => {
    const url = urls[side];
    return url ? [{ side, url }] : [];
  });
  if (!links.length) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {links.map(({ side, url }) => (
        <a
          key={side}
          href={url}
          download={name}
          className="text-[11px] text-primary underline-offset-2 hover:underline"
        >
          Download {SIDE_LABEL[side].toLowerCase()}
        </a>
      ))}
    </span>
  );
}
