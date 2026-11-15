/**
 * Small pieces with no shadcn counterpart. Controls come from
 * `./components/ui/*`.
 */
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { Spinner } from "./components/ui/spinner.tsx";

const cancelPress = (event: { preventDefault(): void }) => event.preventDefault();

/**
 * For a control beside the composer that acts and leaves the user typing:
 * cancelling the press keeps focus, and a phone's keyboard, in the prompt
 * editor. The action stays on click, and keyboard activation is unchanged.
 */
export const KEEP_COMPOSER_FOCUS = { onPointerDown: cancelPress, onMouseDown: cancelPress };

/** A spinner while `pending`, else the icon, if any. */
export function Pending({ pending, icon }: { pending: boolean; icon?: string }) {
  if (pending) return <Spinner />;
  return icon ? <Icon name={icon} className="size-3.5 shrink-0" aria-hidden /> : null;
}

/** A small uppercase label over a section. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-muted-foreground uppercase">
      {children}
    </h2>
  );
}
