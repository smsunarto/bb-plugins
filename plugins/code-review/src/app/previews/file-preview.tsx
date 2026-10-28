import { experimental_usePluginId as usePluginId } from "@get-bb/plugin-sdk/app";
import type { Preview } from "../../shared/previews.ts";
import type { ChangedFile, Comparison, FileBlobs } from "../../shared/schema.ts";
import { Loading, Notice, RetryButton, errorText } from "../notice.tsx";
import { useRpcQuery } from "../rpc.ts";
import { DownloadLinks, StorageFacts, sideUrls } from "./common.tsx";
import { ImageDiff } from "./image-diff.tsx";
import { FontDiff, MediaDiff } from "./media.tsx";
import { ModelDiff } from "./model-diff.tsx";
import { UnityPreview } from "./unity.tsx";

/*
 * A changed file shown as what it is rather than as text: two images, two
 * models, two sounds, two fonts, or a Unity asset's objects. Binary and Git
 * LFS previews read what each side holds first, so a missing side, a
 * symbolic link, or a file too large to preview says so before any download.
 */

/** No preview downloads more than this; the server refuses past it anyway. */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

function SideProblems({ blobs }: { blobs: FileBlobs }) {
  const problems = (["base", "head"] as const).flatMap((side) => {
    const blob = blobs[side];
    const label = side === "base" ? "Before" : "After";
    if (blob.kind === "symlink") return [`${label}: a symbolic link to ${blob.target}.`];
    if (blob.kind === "submodule") return [`${label}: a submodule, not a file.`];
    if (blob.kind === "blob" && (blob.lfs?.size ?? blob.size) > MAX_PREVIEW_BYTES) {
      return [`${label}: too large to preview here.`];
    }
    return [];
  });
  if (!problems.length) return null;
  return (
    <ul className="px-3 pt-2 text-[11px] text-warning-text">
      {problems.map((text) => (
        <li key={text}>{text}</li>
      ))}
    </ul>
  );
}

function BinaryPreview({
  comparison,
  file,
  preview,
}: {
  comparison: Comparison;
  file: ChangedFile;
  preview: Exclude<Preview, { kind: "unity" | "unity-meta" }> | null;
}) {
  const pluginId = usePluginId();
  const blobs = useRpcQuery(
    "fileBlobs",
    { comparison, path: file.path, previousPath: file.previousPath },
    { staleTime: Number.POSITIVE_INFINITY, gcTime: 5 * 60_000 },
  );
  if (blobs.isPending) return <Loading label="Reading the file…" rows={3} className="p-3" />;
  if (blobs.isError) {
    return (
      <Notice
        tone="error"
        title="Could not read the file"
        className="m-3"
        action={<RetryButton onRetry={() => void blobs.refetch()} />}
      >
        {errorText(blobs.error)}
      </Notice>
    );
  }
  const urls = sideUrls(pluginId, comparison, file, blobs.data);
  // Too large, a link, or a submodule: those sides show no content.
  for (const side of ["base", "head"] as const) {
    const blob = blobs.data[side];
    if (blob.kind === "blob" && (blob.lfs?.size ?? blob.size) > MAX_PREVIEW_BYTES)
      urls[side] = null;
  }
  const name = file.path.split("/").at(-1) ?? "file";
  const facts = (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2.5">
      <StorageFacts blobs={blobs.data} />
      <DownloadLinks urls={urls} name={name} />
    </div>
  );
  let body = null;
  if (urls.base === null && urls.head === null) body = null;
  else if (preview?.kind === "image")
    body = <ImageDiff urls={urls} blobs={blobs.data} decoded={preview.decoded} />;
  else if (preview?.kind === "model")
    body = <ModelDiff comparison={comparison} file={file} urls={urls} format={preview.format} />;
  else if (preview?.kind === "audio" || preview?.kind === "video") {
    body = <MediaDiff kind={preview.kind} urls={urls} blobs={blobs.data} />;
  } else if (preview?.kind === "font") body = <FontDiff urls={urls} blobs={blobs.data} />;
  return (
    <>
      {facts}
      <SideProblems blobs={blobs.data} />
      {body ??
        (preview ? (
          <p className="px-3 pt-1.5 pb-2.5 text-[11px] text-muted-foreground">
            Neither side can be shown.
          </p>
        ) : (
          <div className="h-2.5" />
        ))}
    </>
  );
}

/** The preview for `file`, which the card shows instead of, or beside, its text diff. */
export function FilePreview({
  comparison,
  file,
  preview,
  onShowText,
}: {
  comparison: Comparison;
  file: ChangedFile;
  /** Null for a Git LFS file of a kind with no preview: its storage facts and downloads. */
  preview: Preview | null;
  onShowText: (() => void) | null;
}) {
  if (preview?.kind === "unity" || preview?.kind === "unity-meta") {
    return (
      <UnityPreview
        comparison={comparison}
        file={file}
        onShowText={onShowText}
        fallback={<BinaryPreview comparison={comparison} file={file} preview={null} />}
      />
    );
  }
  return <BinaryPreview comparison={comparison} file={file} preview={preview} />;
}
