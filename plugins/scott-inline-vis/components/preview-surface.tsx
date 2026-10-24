import type { ReactNode, RefObject } from "react";

export type SourceToggle = { shown: boolean; onToggle: () => void };

export function PreviewHeader({
  label,
  expanded,
  onToggle,
  onOpen,
  onWide,
  wideTrigger,
  sourceToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (() => void) | null;
  onWide?: () => void;
  wideTrigger?: RefObject<HTMLButtonElement | null>;
  /** HTML written in the reply has no file to open, so it reveals its source. */
  sourceToggle?: SourceToggle;
}) {
  // Upstream #4507 and #4538: the whole row toggles in place, and opening the
  // file is a separate trailing action so the two never look alike.
  return (
    <figcaption className="inline-vis-header">
      <button
        type="button"
        className="inline-vis-toggle"
        aria-label={`${expanded ? "Collapse" : "Expand"} visualization ${label}`}
        aria-expanded={expanded}
        title={expanded ? "Collapse preview" : "Expand preview here"}
        onClick={onToggle}
      >
        <span className="inline-vis-label">inline-vis</span>
        <span className="inline-vis-path" title={label}>
          <bdi>{label}</bdi>
        </span>
        {/* Sized attributes keep icons small if they render before app.css applies. */}
        <svg
          aria-hidden="true"
          className="inline-vis-chevron"
          width="10"
          height="16"
          viewBox="0 0 10 16"
          fill="currentColor"
        >
          <path d="M.47 5.47a.75.75 0 0 1 1.06 0L5 8.94l3.47-3.47a.75.75 0 0 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" />
        </svg>
      </button>
      {onWide ? (
        <button
          type="button"
          ref={wideTrigger}
          className="inline-vis-action inline-vis-icon"
          aria-label="Wide view"
          title="Wide view"
          onClick={onWide}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      ) : (
        // Hold the slot while loading so the row does not shift when it appears.
        expanded && <span aria-hidden="true" className="inline-vis-action" />
      )}
      {sourceToggle ? (
        <button
          type="button"
          className="inline-vis-action inline-vis-icon"
          aria-label={sourceToggle.shown ? "Hide source" : "Show source"}
          aria-pressed={sourceToggle.shown}
          title={sourceToggle.shown ? "Hide source" : "Show source"}
          onClick={sourceToggle.onToggle}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
          </svg>
        </button>
      ) : onOpen === null ? (
        <span aria-hidden="true" className="inline-vis-action" />
      ) : (
        <button
          type="button"
          className="inline-vis-action inline-vis-icon inline-vis-open"
          aria-label={`Open ${label} in sidebar`}
          title="Open in sidebar"
          onClick={onOpen}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </button>
      )}
    </figcaption>
  );
}

export function PreviewActions({
  hasTweaks,
  canShareState,
  tweakOpen,
  saving,
  onTweak,
  onShare,
}: {
  hasTweaks: boolean;
  canShareState: boolean;
  tweakOpen: boolean;
  saving: boolean;
  onTweak: () => void;
  onShare: () => void;
}) {
  return (
    <>
      {hasTweaks && (
        <button type="button" aria-expanded={tweakOpen} onClick={onTweak}>
          Tweak
        </button>
      )}
      {canShareState && (
        <button type="button" disabled={saving} onClick={onShare}>
          Use saved state
        </button>
      )}
    </>
  );
}

/** The shared presentation of an inline preview and its wide inspector. */
export function PreviewSurface({
  dialogRef,
  wide,
  label,
  wideLabel = label,
  onLeaveWide,
  actions,
  notice,
  preview,
  panel,
  showPanel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  wide: boolean;
  label: string;
  wideLabel?: string;
  onLeaveWide: () => void;
  actions: ReactNode;
  notice?: ReactNode;
  preview: ReactNode;
  panel?: ReactNode;
  showPanel: boolean;
}) {
  return (
    <dialog
      ref={dialogRef}
      className={`inline-vis-surface${wide ? " inline-vis-wide" : ""}`}
      role={wide ? "dialog" : "region"}
      aria-label={wide ? `Wide visualization: ${label}` : `Visualization: ${label}`}
      aria-modal={wide || undefined}
      onCancel={(event) => {
        event.preventDefault();
        onLeaveWide();
      }}
    >
      {wide && (
        <div className="inline-vis-wide-header">
          <span>{wideLabel}</span>
          <div>
            {actions}
            <button type="button" onClick={onLeaveWide}>
              Back to chat
            </button>
          </div>
        </div>
      )}
      {notice}
      <div className={`inline-vis-workspace${showPanel ? " inline-vis-with-tweaks" : ""}`}>
        <div className="inline-vis-preview">{preview}</div>
        {showPanel && panel}
      </div>
    </dialog>
  );
}
