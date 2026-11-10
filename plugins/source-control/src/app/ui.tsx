/**
 * The tab's few controls, drawn with theme tokens so no shared stylesheet is
 * loaded for them. Shapes follow the GitButler panel's outline buttons.
 */
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./format.ts";

const BASE =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[12px] leading-4 whitespace-nowrap transition-colors duration-150 disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1";

const VARIANT = {
  outline:
    "border border-border-hairline bg-transparent text-foreground enabled:hover:bg-surface-raised",
  ghost: "bg-transparent text-foreground enabled:hover:bg-surface-raised",
  primary: "bg-foreground font-semibold text-background enabled:hover:opacity-90",
  destructive: "bg-destructive font-semibold text-destructive-foreground enabled:hover:opacity-90",
} as const;

export type ButtonVariant = keyof typeof VARIANT;

export function Button({
  variant = "outline",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={cx(BASE, VARIANT[variant], className)} {...props} />;
}

/** A spinner while `pending`, else the icon, if any. */
export function Pending({ pending, icon }: { pending: boolean; icon?: string }) {
  if (pending)
    return (
      <Icon
        name="Spinner"
        fallback="Loader"
        className="size-3.5 animate-spin motion-reduce:animate-none"
        aria-hidden
      />
    );
  return icon ? <Icon name={icon} className="size-3.5 shrink-0" aria-hidden /> : null;
}

/** GitButler's solid count pill. */
export function Count({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-surface-raised px-1.5 text-[11px] leading-none font-semibold text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

/** A small uppercase label over a section. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

/** Placeholder bar, shimmering while its data loads. */
export function Bar({ className }: { className: string }) {
  return (
    <div
      className={cx(
        "shrink-0 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none",
        className,
      )}
    />
  );
}
