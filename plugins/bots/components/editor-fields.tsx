import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../lib/utils";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

/** A labelled form field with optional helper text, in shadcn's Field layout. */
export function Field({
  label,
  htmlFor,
  detail,
  aside,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  detail?: ReactNode;
  /** Right-aligned beside the label, such as a character count. */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex min-h-4 items-center justify-between gap-2">
        {htmlFor ? (
          <Label htmlFor={htmlFor}>{label}</Label>
        ) : (
          <span className="text-xs leading-none font-medium">{label}</span>
        )}
        {aside}
      </div>
      {children}
      {detail ? <p className="text-[11px] leading-4 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/** A bordered settings row: title and description on the left, a Switch on the right. */
export function SwitchRow({
  id,
  label,
  detail,
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  id: string;
  label: string;
  detail: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Shown under the row while it is on. */
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 p-3">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id}>{label}</Label>
          <p className="text-[11px] leading-4 text-muted-foreground">{detail}</p>
        </div>
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      </div>
      {children ? <div className="border-t border-border p-3">{children}</div> : null}
    </div>
  );
}

/** A small heading that opens a group of fields. */
export function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold">{title}</h3>
      {detail ? <p className="text-[11px] leading-4 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/**
 * Keep typing in a text area from reaching host shortcuts, but let Escape and
 * Tab through so the dialog or drawer can still close and move focus.
 */
export function keepTypingKeys(event: KeyboardEvent) {
  if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
}
