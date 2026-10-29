import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/*
 * Row recipes ported from t3code's thread details panel
 * (apps/web/src/components/chat/threadDetailsPanelStyles.ts): 32px rows with
 * a faint fill on hover, and split rows whose hairline appears only while the
 * pair is in use, so resting rows read as plain rows.
 */

declare const __BB_PLUGIN_ID__: string | undefined;

/**
 * Attributes a portaled overlay needs so this plugin's scoped Tailwind rules
 * and bb's overlay stacking reach it outside the plugin root (bb registry's
 * `lib/portal-scope`).
 */
export const PORTAL_SCOPE = {
  "data-bb-portaled-overlay": "",
  "data-bb-plugin-root": "",
  ...(typeof __BB_PLUGIN_ID__ === "string" ? { "data-bb-plugin": __BB_PLUGIN_ID__ } : {}),
} as const;

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const HOVER =
  "hover:bg-foreground/[0.035] data-[state=open]:bg-foreground/[0.035] [.dark_&]:hover:bg-foreground/[0.08] [.dark_&]:data-[state=open]:bg-foreground/[0.08]";
const CONTROL =
  "flex h-8 min-w-0 cursor-pointer items-center rounded-lg border border-transparent bg-transparent text-left text-[13px] font-medium text-foreground/80 outline-none transition-[background-color,scale] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 [&:active:not([aria-haspopup]):not(:disabled)]:scale-[0.98]";
const ROW_CONTENT = "gap-2.5 px-2.5";

export function RowIcon({ name }: { name: string }) {
  return <Icon name={name} aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

export function RowLabel({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-0 flex-1 overflow-x-clip overflow-y-visible whitespace-nowrap [text-box:trim-both_cap_alphabetic]">
      {children}
    </span>
  );
}

export function Row({ className, ...props }: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cx(CONTROL, ROW_CONTENT, "w-full", HOVER, className)}
    />
  );
}

/** A static row: the same box as `Row`, for facts with no action. */
export function InfoRow({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div {...props} className={cx(CONTROL, ROW_CONTENT, "w-full cursor-default", className)} />
  );
}

/** A primary action with a chevron menu beside it, as t3code's split rows. */
export function SplitRow({
  primary,
  menuLabel,
  menu,
}: {
  primary: ReactNode;
  menuLabel: string;
  menu: ReactNode;
}) {
  return (
    <div
      className={cx(
        "group/split flex w-full items-center rounded-lg has-[[data-state=open]]:bg-foreground/[0.035] [.dark_&]:has-[[data-state=open]]:bg-foreground/[0.08]",
        HOVER,
      )}
    >
      {primary}
      <Menu
        trigger={
          <button
            type="button"
            aria-label={menuLabel}
            className={cx(
              CONTROL,
              "relative w-8 shrink-0 justify-center rounded-s-none px-0 before:absolute before:-left-px before:top-1/2 before:h-4 before:w-px before:-translate-y-1/2 before:bg-transparent group-hover/split:before:bg-border/65 group-has-[[data-state=open]]/split:before:bg-border/65",
              HOVER,
            )}
          >
            <RowIcon name="ChevronDown" />
          </button>
        }
      >
        {menu}
      </Menu>
    </div>
  );
}

export function SplitPrimary({ className, ...props }: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cx(CONTROL, ROW_CONTENT, "flex-1 rounded-e-none", HOVER, className)}
    />
  );
}

/** A whole row that opens a menu, with the chevron at its end. */
export function SelectRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <Menu
      trigger={
        <button
          type="button"
          aria-haspopup="menu"
          className={cx(CONTROL, "group/select w-full gap-0 px-0", HOVER)}
        >
          <span
            className={cx(
              "flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-s-lg px-2.5",
              HOVER,
            )}
          >
            {icon}
            <RowLabel>{label}</RowLabel>
          </span>
          <span
            className={cx(
              "relative flex h-full w-8 shrink-0 items-center justify-center rounded-e-lg before:absolute before:-left-px before:top-1/2 before:h-4 before:w-px before:-translate-y-1/2 before:bg-transparent group-hover/select:before:bg-border/65 group-data-[state=open]/select:before:bg-border/65",
              HOVER,
            )}
          >
            <RowIcon name="ChevronDown" />
          </span>
        </button>
      }
    >
      {children}
    </Menu>
  );
}

const MENU_ITEM =
  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground/85 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-foreground/[0.08] data-[highlighted]:text-foreground";

export function Menu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...PORTAL_SCOPE}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-[12rem] max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  icon,
  children,
  detail,
  tone,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof DropdownMenu.Item>, "className"> & {
  icon?: string;
  detail?: ReactNode;
  tone?: "destructive";
}) {
  return (
    <DropdownMenu.Item
      {...props}
      className={cx(MENU_ITEM, tone === "destructive" && "text-destructive")}
    >
      {icon ? <RowIcon name={icon} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {detail ? (
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
      {children}
    </DropdownMenu.Label>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border/65" />;
}

export function Section({
  label,
  separated = true,
  children,
}: {
  label: string;
  separated?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cx("flex flex-col px-2 pt-2 pb-2.5", separated && "border-t border-border/65")}
    >
      {children}
    </section>
  );
}
