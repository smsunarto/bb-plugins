import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import { cn } from "@/lib/utils";
import { MAX_ATTACHMENT_SIZE_BYTES } from "../shared/attachments.js";
import type { AttachmentOwner } from "../shared/contract.js";
import { errorMessage } from "../shared/errors.js";
import { formatFileSize } from "../views/activity/time.js";
import { uploadAttachment } from "../views/detail/attachments.js";

export type StagedAttachment = { id: number; file: File } & (
  | { status: "staged" }
  | { status: "oversized"; error: string }
  | { status: "failed"; owner: AttachmentOwner; error: string; retrying: boolean }
);

export type FailedAttachment = Extract<StagedAttachment, { status: "failed" }>;

let nextStagedId = 0;

export function stageFiles(files: readonly File[]): StagedAttachment[] {
  return files.map((file) =>
    file.size > MAX_ATTACHMENT_SIZE_BYTES
      ? {
          id: nextStagedId++,
          file,
          status: "oversized" as const,
          error: `Over the 25 MB attachment limit (${formatFileSize(file.size)})`,
        }
      : { id: nextStagedId++, file, status: "staged" as const },
  );
}

export async function uploadStagedAttachments(
  staged: readonly StagedAttachment[],
  owner: AttachmentOwner,
): Promise<FailedAttachment[]> {
  const failed: FailedAttachment[] = [];
  for (const entry of staged) {
    try {
      await uploadAttachment(entry.file, owner);
    } catch (cause) {
      failed.push({
        id: entry.id,
        file: entry.file,
        status: "failed",
        owner,
        error: errorMessage(cause),
        retrying: false,
      });
    }
  }
  return failed;
}

export function settleStagedUploads(
  files: readonly StagedAttachment[],
  staged: readonly StagedAttachment[],
  failed: readonly FailedAttachment[],
): StagedAttachment[] {
  return files.flatMap((entry) => {
    const failure = failed.find((candidate) => candidate.id === entry.id);
    if (failure) return [failure];
    return staged.some((candidate) => candidate.id === entry.id) ? [] : [entry];
  });
}

export function useStagedAttachmentRetry(
  setPendingFiles: Dispatch<SetStateAction<StagedAttachment[]>>,
  onUploaded?: () => void,
) {
  const retryingRef = useRef(new Set<number>());
  return async (entry: FailedAttachment) => {
    if (retryingRef.current.has(entry.id)) return;
    retryingRef.current.add(entry.id);
    setPendingFiles((files) =>
      files.map((candidate) =>
        candidate.id === entry.id ? { ...entry, retrying: true } : candidate,
      ),
    );
    try {
      await uploadAttachment(entry.file, entry.owner);
      setPendingFiles((files) => files.filter((candidate) => candidate.id !== entry.id));
      onUploaded?.();
    } catch (cause) {
      const message = errorMessage(cause);
      setPendingFiles((files) =>
        files.map((candidate) =>
          candidate.id === entry.id ? { ...entry, retrying: false, error: message } : candidate,
        ),
      );
    } finally {
      retryingRef.current.delete(entry.id);
    }
  };
}

function ChipThumbnail({ file }: { file: File }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!previewUrl) return null;
  return (
    <img
      src={previewUrl}
      alt=""
      aria-hidden
      className="size-5 shrink-0 rounded-sm border border-border object-cover"
    />
  );
}

export function AttachmentChip({
  entry,
  onRemove,
  onRetry,
  disabled = false,
}: {
  entry: StagedAttachment;
  onRemove: () => void;
  onRetry: (entry: FailedAttachment) => void;
  disabled?: boolean;
}) {
  const broken = entry.status !== "staged";
  const error = entry.status === "staged" ? undefined : entry.error;
  const retrying = entry.status === "failed" && entry.retrying;
  const image = entry.file.type.startsWith("image/");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
        broken
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : "border-border bg-background",
      )}
      title={error}
    >
      {!broken && image ? (
        <ChipThumbnail file={entry.file} />
      ) : (
        <HugeiconsIcon
          icon={File01Icon}
          className={cn("size-3", broken ? undefined : "text-muted-foreground")}
        />
      )}
      <span className="max-w-40 truncate">{entry.file.name}</span>
      <span className={cn("text-2xs", broken ? "text-destructive/80" : "text-muted-foreground")}>
        {formatFileSize(entry.file.size)}
      </span>
      {error ? <span className="sr-only">{error}</span> : null}
      {entry.status === "failed" ? (
        <button
          type="button"
          aria-label={`Retry upload of ${entry.file.name}`}
          aria-busy={entry.retrying}
          disabled={disabled || entry.retrying}
          className="font-medium underline underline-offset-2 disabled:opacity-60"
          onClick={() => onRetry(entry)}
        >
          {entry.retrying ? "Retrying…" : "Retry"}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${entry.file.name}`}
        disabled={disabled || retrying}
        className={cn(
          "disabled:opacity-60",
          !broken && "text-muted-foreground hover:text-foreground",
        )}
        onClick={onRemove}
      >
        <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
      </button>
    </span>
  );
}
