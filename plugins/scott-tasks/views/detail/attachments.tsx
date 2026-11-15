import { useState } from "react";
import { attachmentDownloadUrl } from "../../shared/attachments.js";
import type { Attachment, AttachmentOwner } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { formatFileSize } from "../activity/time.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Hint } from "../../components/hint.js";
import { experimental_ImageLightbox as ImageLightbox } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

let tokenPromise: Promise<string> | null = null;

function pluginToken(): Promise<string> {
  tokenPromise ??= (async () => {
    const response = await fetch("/api/v1/plugins/scott-tasks/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const json: unknown = await response.json().catch(() => null);
    const token =
      json && typeof json === "object" && "token" in json
        ? (json as { token: unknown }).token
        : undefined;
    if (!response.ok || typeof token !== "string") {
      throw new Error(`failed to fetch plugin token (HTTP ${response.status})`);
    }
    return token;
  })();
  tokenPromise.catch(() => {
    tokenPromise = null;
  });
  return tokenPromise;
}

export async function uploadAttachment(
  file: File,
  owner: AttachmentOwner,
): Promise<{ attachmentId: string; url: string }> {
  const token = await pluginToken();
  const query = new URLSearchParams({
    fileName: file.name || "attachment",
    mime: file.type || "application/octet-stream",
  });
  if (owner.kind === "task") query.set("taskId", owner.taskId);
  else query.set("commentId", owner.commentId);
  const response = await fetch(
    `/api/v1/plugins/scott-tasks/http/attachments/upload?${query.toString()}`,
    {
      method: "POST",
      headers: { "x-bb-plugin-token": token },
      body: file,
    },
  );
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `upload failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  const result = json as { attachmentId: string; url: string };
  return { attachmentId: result.attachmentId, url: result.url };
}

/** Shows an image attachment in bb's lightbox. Mount it only while an image is open. */
export function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  return (
    <ImageLightbox
      imageSrc={attachmentDownloadUrl(attachment.id)}
      imageAlt={attachment.fileName}
      title={`${attachment.fileName} · ${formatFileSize(attachment.sizeBytes)}`}
      onClose={onClose}
    />
  );
}

function RemovalSpinner() {
  return (
    <span role="status" aria-label="Removing" className="flex">
      <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" />
    </span>
  );
}

export function AttachmentsGrid({
  attachments,
  onRemove,
  onError,
}: {
  attachments: Attachment[];
  onRemove: (attachment: Attachment) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [confirm, setConfirm] = useState<Attachment | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const requestRemove = (attachment: Attachment) => setConfirm(attachment);

  const performRemove = async (attachment: Attachment) => {
    setConfirm(null);
    setLightbox((current) => (current?.id === attachment.id ? null : current));
    setPending((current) => new Set(current).add(attachment.id));
    try {
      await onRemove(attachment);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(attachment.id);
        return next;
      });
    }
  };

  if (attachments.length === 0) return null;

  const files = attachments.filter((attachment) => !attachment.isImage);
  const images = attachments.filter((attachment) => attachment.isImage);

  const removeButton = (attachment: Attachment, variant: "image" | "file") => {
    const busy = pending.has(attachment.id);
    return (
      <Button
        variant={variant === "image" ? "secondary" : "ghost"}
        size="icon"
        aria-label={`Remove ${attachment.fileName}`}
        disabled={busy}
        className={
          variant === "image"
            ? "absolute right-1 top-1 z-10 size-5 rounded-full"
            : "size-5 shrink-0 text-muted-foreground"
        }
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) requestRemove(attachment);
        }}
      >
        {busy ? <RemovalSpinner /> : <Icon name="X" className="size-3" />}
      </Button>
    );
  };

  const fileCard = (attachment: Attachment) => (
    <div
      key={attachment.id}
      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm shadow-2xs"
    >
      <a
        href={attachmentDownloadUrl(attachment.id)}
        download={attachment.fileName}
        className="flex min-w-0 items-center gap-2 rounded-sm hover:bg-state-hover"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground">
          <Icon name="File" className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block max-w-48 truncate">{attachment.fileName}</span>
          <span className="block text-2xs text-muted-foreground">
            {formatFileSize(attachment.sizeBytes)}
          </span>
        </span>
      </a>
      {removeButton(attachment, "file")}
    </div>
  );

  const imageTile = (attachment: Attachment) => (
    <div
      key={attachment.id}
      className="group relative overflow-hidden rounded-md border border-border shadow-2xs"
    >
      <Hint label={`${attachment.fileName} · ${formatFileSize(attachment.sizeBytes)}`}>
        <button type="button" className="block" onClick={() => setLightbox(attachment)}>
          <img
            src={attachmentDownloadUrl(attachment.id)}
            alt={attachment.fileName}
            className="block h-24 w-36 object-cover transition-opacity group-hover:opacity-90"
          />
          <span
            className="absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-left text-2xs opacity-0 transition-opacity group-hover:opacity-100"
            style={{
              background: "color-mix(in oklab, var(--ink) 55%, transparent)",
              color: "var(--canvas)",
            }}
          >
            {attachment.fileName}
          </span>
        </button>
      </Hint>
      {removeButton(attachment, "image")}
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2">{files.map(fileCard)}</div>
      ) : null}
      {images.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2">{images.map(imageTile)}</div>
      ) : null}
      {lightbox ? <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} /> : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        heading="Remove attachment?"
        description={
          confirm
            ? `"${confirm.fileName}" will be permanently removed. Any references in the task description will be removed too. This cannot be undone.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={() => {
          if (confirm) void performRemove(confirm);
        }}
      />
    </div>
  );
}
