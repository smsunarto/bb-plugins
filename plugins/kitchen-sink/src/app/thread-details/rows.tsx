import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithRef, ComponentPropsWithoutRef, ReactNode, Ref } from "react";

/*
 * bb draws the rows themselves (`experimental_ThreadContextCardRow`); these are
 * the menus and buttons the card's rows carry in their `action` slot.
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

function RowIcon({ name }: { name: string }) {
  return <Icon name={name} aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

const ACTION_BUTTON =
  "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 data-[state=open]:bg-state-hover data-[state=open]:text-foreground max-md:pointer-coarse:size-7";

/** An icon button for a card row's `action` slot. */
export function RowActionButton({
  icon,
  label,
  ...props
}: Omit<ComponentPropsWithRef<"button">, "children" | "className"> & {
  icon: string;
  label: string;
}) {
  // `props.ref` carries Radix's composed trigger ref, so it must reach the button.
  return (
    <button type="button" aria-label={label} title={label} {...props} className={ACTION_BUTTON}>
      <Icon name={icon} aria-hidden className="size-3.5" />
    </button>
  );
}

/** A card row's `action`: a chevron that opens the row's menu. */
export function RowMenu({
  label,
  triggerRef,
  children,
}: {
  label: string;
  triggerRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <Menu trigger={<RowActionButton icon="ChevronDown" label={label} ref={triggerRef} />}>
      {children}
    </Menu>
  );
}

const MENU_ITEM =
  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground/85 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-foreground/[0.08] data-[highlighted]:text-foreground";

function Menu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...PORTAL_SCOPE}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-[12rem] max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
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
