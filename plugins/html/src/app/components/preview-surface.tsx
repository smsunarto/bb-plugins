import type { ReactNode, RefObject } from "react";

export function PreviewHeader({
  label,
  expanded,
  onToggle,
  onWide,
  wideTrigger,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onWide?: () => void;
  wideTrigger?: RefObject<HTMLButtonElement | null>;
}) {
  // The whole row toggles in place; Wide view is a separate trailing action.
  return (
    <figcaption className="html-page-header">
      <button
        type="button"
        className="html-page-toggle"
        aria-label={`${expanded ? "Collapse" : "Expand"} visualization ${label}`}
        aria-expanded={expanded}
        title={expanded ? "Collapse preview" : "Expand preview here"}
        onClick={onToggle}
      >
        <span className="html-page-label">HTML</span>
        <span className="html-page-path" title={label}>
          <bdi>{label}</bdi>
        </span>
        {/* Sized attributes keep icons small if they render before app.css applies. */}
        <svg
          aria-hidden="true"
          className="html-page-chevron"
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
          className="html-page-action html-page-icon"
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
        expanded && <span aria-hidden="true" className="html-page-action" />
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
      className={`html-page-surface${wide ? " html-page-wide" : ""}`}
      role={wide ? "dialog" : "region"}
      aria-label={wide ? `Wide visualization: ${label}` : `Visualization: ${label}`}
      aria-modal={wide || undefined}
      onCancel={(event) => {
        event.preventDefault();
        onLeaveWide();
      }}
    >
      {wide && (
        <div className="html-page-wide-header">
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
      <div className={`html-page-workspace${showPanel ? " html-page-with-tweaks" : ""}`}>
        <div className="html-page-preview">{preview}</div>
        {showPanel && panel}
      </div>
    </dialog>
  );
}
