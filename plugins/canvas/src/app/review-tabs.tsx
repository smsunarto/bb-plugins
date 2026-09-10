import type { KeyboardEvent } from "react";

export function ReviewTabs({
  id,
  tab,
  onTabChange,
  commentCount,
  editCount,
}: {
  id: string;
  tab: "comments" | "edits";
  onTabChange(tab: "comments" | "edits"): void;
  commentCount: number;
  editCount: number;
}) {
  const tabs = [
    { value: "comments", label: "Comments", accessibleLabel: "Comments", count: commentCount },
    { value: "edits", label: "Edits", accessibleLabel: "Suggested edits", count: editCount },
  ] as const;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: "comments" | "edits";
    if (event.key === "Home") next = "comments";
    else if (event.key === "End") next = "edits";
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft")
      next = tab === "comments" ? "edits" : "comments";
    else return;
    event.preventDefault();
    onTabChange(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
      ?.focus();
  };
  return (
    <div className="canvas-review-tabs" role="tablist" aria-label="Review">
      {tabs.map((item) => (
        <button
          key={item.value}
          id={`${id}-${item.value}-tab`}
          type="button"
          role="tab"
          data-tab={item.value}
          aria-selected={tab === item.value}
          aria-controls={`${id}-${item.value}`}
          aria-label={`${item.accessibleLabel} (${item.count})`}
          tabIndex={tab === item.value ? 0 : -1}
          onKeyDown={onKeyDown}
          onClick={() => onTabChange(item.value)}
        >
          {item.label} <span className="canvas-review-count">{item.count}</span>
        </button>
      ))}
    </div>
  );
}
