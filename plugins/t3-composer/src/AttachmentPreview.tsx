import { VideoThumbnail } from "@/components/ui/video-thumbnail";
import { useEffect, useState, type ReactNode } from "react";
import {
  experimental_ImageLightbox as ImageLightbox,
  experimental_useComposerRenderer as useComposerRenderer,
  type ComposerAttachment,
  type ExperimentalComposerPendingUpload as PendingAttachmentUpload,
  type ExperimentalComposerRendererApi,
} from "@get-bb/plugin-sdk/app";
import { isImageAttachment, isVideoAttachment, wrappedIndex } from "./attachments";
import { useComposerHandle } from "./composer-handle";
import {
  groupContextMentions,
  withoutMentions,
  type ContextMentionGroup,
} from "./context-mentions";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function resolveAttachmentPreviewSrc(
  renderer: ExperimentalComposerRendererApi,
  path: string,
  attachmentProjectId: string | undefined,
): string {
  return renderer.attachmentSrc(path, attachmentProjectId);
}

/* ChatGPT-style tiles: 120px tall, image tiles square, file tiles wider with a name footer. */
const TILE_CLASS =
  "relative flex h-[120px] shrink-0 flex-col overflow-hidden rounded-[12px] border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)] bg-background";
const IMAGE_TILE_CLASS = `${TILE_CLASS} w-[120px]`;
const NO_PENDING_UPLOADS: readonly PendingAttachmentUpload[] = [];
const FILE_TILE_CLASS = `${TILE_CLASS} w-[160px]`;
function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-t3-attachment-remove=""
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.currentTarget.blur();
        onRemove();
      }}
      className="group/attachment-remove absolute right-1 top-1 z-10 size-5 rounded-full hover:bg-transparent max-md:pointer-coarse:size-7"
      aria-label={label}
    >
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors group-hover/attachment-remove:bg-black/80">
        <Icon name="X" className="size-3" />
      </span>
    </Button>
  );
}

interface AttachmentPreviewProps {
  attachments: readonly ComposerAttachment[];
  pendingUploads?: readonly PendingAttachmentUpload[];
  compact?: boolean;
  attachmentProjectId?: string;
  expandedImageIndex: number | null;
  onExpandedImageIndexChange: (index: number | null) => void;
  onRemoveAttachment?: (path: string) => void;
}

function isImageUpload(upload: PendingAttachmentUpload): boolean {
  return (
    upload.file.type.startsWith("image/") ||
    isVideoAttachment({ path: upload.file.name, mimeType: upload.file.type })
  );
}

function ImageUploadPreview({ file }: { file: File }) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    // The URL is created and revoked as one effect pair; creating it in render would leak it.
    // oxlint-disable-next-line react/set-state-in-effect
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <output aria-label={`Uploading ${file.name}`} className={IMAGE_TILE_CLASS}>
      <span className="block size-full">
        {previewUrl ? (
          isVideoAttachment({ path: file.name, mimeType: file.type }) ? (
            <VideoThumbnail src={previewUrl} className="opacity-50" />
          ) : (
            <img src={previewUrl} alt="" className="size-full object-cover opacity-50" />
          )
        ) : null}
      </span>
      <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-background/90 py-1 text-xs text-foreground">
        <Icon name="Loading" className="size-3 animate-spin motion-reduce:animate-none" />
        Uploading
      </span>
    </output>
  );
}

function FileAttachmentName({ name, path }: { name: string; path: string }) {
  const resolveMentionLink = useComposerRenderer().input.resolveMentionLink;
  const open = resolveMentionLink({ kind: "attachment", path, label: name });
  if (!open) {
    return <span className="truncate">{name}</span>;
  }
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      onMouseDown={(event) => event.preventDefault()}
      onClick={open}
      className="block h-auto min-w-0 truncate p-0 text-[13px] font-normal text-foreground focus-visible:underline"
    >
      {name}
    </Button>
  );
}

function FileTile({
  name,
  children,
  footer,
}: {
  name: string;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div data-t3-attachment-file="" className={FILE_TILE_CLASS} title={name}>
      <span className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Icon name="File" className="size-6" />
      </span>
      <span className="flex h-9 min-w-0 shrink-0 items-center gap-1 bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-2 text-[13px] text-foreground">
        <Icon name="File" className="size-4 shrink-0" />
        {footer}
      </span>
      {children}
    </div>
  );
}

function FileUploadPreview({ file }: { file: File }) {
  return (
    <output aria-label={`Uploading ${file.name}`} className="contents">
      <FileTile
        name={file.name}
        footer={
          <>
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <Icon
              name="Loading"
              className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
            />
          </>
        }
      />
    </output>
  );
}

const CONTEXT_CHIP_LABEL_CLASS = "h-full gap-1 rounded-lg pl-2 pr-1 text-[13px] font-normal";

function ContextMentionChip({ group }: { group: ContextMentionGroup }) {
  const composer = useComposerHandle();
  const resolveMentionLink = useComposerRenderer().input.resolveMentionLink;
  const first = group.mentions[0]!;
  const open = resolveMentionLink({
    kind: "plugin",
    pluginId: first.pluginId,
    provider: first.provider,
    id: first.id,
    label: first.label,
    icon: first.icon,
  });
  const keys = new Set(group.mentions.map((mention) => `${mention.from}:${mention.to}`));
  const label = (
    <>
      <Icon name="MessageSquare" className="size-4 shrink-0 text-muted-foreground" />
      {group.label}
    </>
  );
  return (
    <span
      data-t3-context-chip=""
      className="relative inline-flex h-8 shrink-0 items-center rounded-[10px] border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)] bg-background text-[13px] text-foreground"
    >
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            {open ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onMouseDown={(event) => event.preventDefault()}
                onClick={open}
                className={CONTEXT_CHIP_LABEL_CLASS}
              >
                {label}
              </Button>
            ) : (
              <span className={cn("inline-flex items-center", CONTEXT_CHIP_LABEL_CLASS)}>
                {label}
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent side="top" className="whitespace-pre-line">
            {group.mentions.map((mention) => mention.label).join("\n")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() =>
          composer.replace((current) =>
            withoutMentions(current, (mention) => keys.has(`${mention.from}:${mention.to}`)),
          )
        }
        aria-label={`Remove ${group.label}`}
        className="mr-1 size-6 rounded-full text-muted-foreground"
      >
        <Icon name="X" className="size-3" />
      </Button>
    </span>
  );
}

export function AttachmentPreview({
  attachments,
  pendingUploads = NO_PENDING_UPLOADS,
  compact = false,
  attachmentProjectId,
  expandedImageIndex,
  onExpandedImageIndexChange,
  onRemoveAttachment,
}: AttachmentPreviewProps) {
  const renderer = useComposerRenderer();
  const contextGroups = groupContextMentions(useComposerHandle().draft.mentions);
  const imageAttachments = attachments.filter(
    (attachment) => isImageAttachment(attachment) || isVideoAttachment(attachment),
  );
  const nonImageAttachments = attachments.filter(
    (attachment) => !isImageAttachment(attachment) && !isVideoAttachment(attachment),
  );
  const imageUploads = pendingUploads.filter(isImageUpload);
  const fileUploads = pendingUploads.filter((upload) => !isImageUpload(upload));
  const attachmentImageItems = imageAttachments.map((attachment) => ({
    mediaType: isVideoAttachment(attachment) ? ("video" as const) : ("image" as const),
    alt: attachment.name,
    src: resolveAttachmentPreviewSrc(
      renderer,
      attachment.path,
      attachment.sourceProjectId ?? attachmentProjectId,
    ),
  }));
  const hasMultipleAttachmentImages = imageAttachments.length > 1;
  const currentAttachmentImage =
    expandedImageIndex !== null ? (attachmentImageItems[expandedImageIndex] ?? null) : null;

  useEffect(() => {
    if (expandedImageIndex === null) return;
    if (expandedImageIndex < imageAttachments.length) return;
    onExpandedImageIndexChange(null);
  }, [expandedImageIndex, imageAttachments.length, onExpandedImageIndexChange]);

  const attachmentCount = attachments.length;
  const uploadingCount = pendingUploads.length;
  // The expanded row stays mounted, empty and hidden, so other plugins can
  // place chips in its context slot (see composer.css).
  if (compact && attachmentCount + uploadingCount === 0) return null;

  return (
    <>
      {compact ? (
        <span
          data-promptbox-attachments=""
          role={uploadingCount > 0 ? "status" : "img"}
          aria-label={[
            attachmentCount > 0
              ? `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`
              : null,
            uploadingCount > 0 ? `${uploadingCount} uploading` : null,
          ]
            .filter(Boolean)
            .join(", ")}
          className="ml-3 inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-surface-recessed px-1 text-xs text-muted-foreground"
        >
          <Icon name="Paperclip" className="size-3.5" />
          <span aria-hidden="true">{attachmentCount + uploadingCount}</span>
          {uploadingCount > 0 ? (
            <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : null}
        </span>
      ) : (
        <div data-t3-attachments="" className="flex flex-wrap items-end gap-2 p-1">
          {nonImageAttachments.map((attachment) => (
            <FileTile
              key={attachment.path}
              name={attachment.name}
              footer={
                <span className="flex min-w-0 flex-1">
                  <FileAttachmentName name={attachment.name} path={attachment.path} />
                </span>
              }
            >
              {onRemoveAttachment ? (
                <RemoveButton
                  label={`Remove ${attachment.name}`}
                  onRemove={() => onRemoveAttachment(attachment.path)}
                />
              ) : null}
            </FileTile>
          ))}
          {fileUploads.map((upload) => (
            <FileUploadPreview key={upload.id} file={upload.file} />
          ))}
          {imageAttachments.map((attachment, index) => (
            <div key={`${attachment.path}-${index}`} className={IMAGE_TILE_CLASS}>
              <button
                type="button"
                className="block size-full cursor-zoom-in"
                onClick={() => onExpandedImageIndexChange(index)}
                aria-label={attachment.name}
              >
                {isVideoAttachment(attachment) ? (
                  <VideoThumbnail src={attachmentImageItems[index]!.src} />
                ) : (
                  <img
                    src={attachmentImageItems[index]?.src}
                    alt={attachment.name}
                    className="size-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                )}
              </button>
              {onRemoveAttachment ? (
                <RemoveButton
                  label={`Remove ${attachment.name}`}
                  onRemove={() => onRemoveAttachment(attachment.path)}
                />
              ) : null}
            </div>
          ))}
          {imageUploads.map((upload) => (
            <ImageUploadPreview key={upload.id} file={upload.file} />
          ))}
          {contextGroups.map((group) => (
            <ContextMentionChip key={group.key} group={group} />
          ))}
          {/* Other plugins portal attachment-like chips here, such as Agentation's staged annotations. */}
          <span data-composer-context-slot="" className="contents" />
        </div>
      )}

      <ImageLightbox
        imageSrc={currentAttachmentImage?.src ?? null}
        imageAlt={currentAttachmentImage?.alt ?? "Attached image"}
        title="Attached media preview"
        mediaType={currentAttachmentImage?.mediaType}
        hasMultipleImages={hasMultipleAttachmentImages}
        onPrevious={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : wrappedIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onNext={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : wrappedIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onClose={() => onExpandedImageIndexChange(null)}
      />
    </>
  );
}
