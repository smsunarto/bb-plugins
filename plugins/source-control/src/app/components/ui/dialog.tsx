/* shadcn/ui-derived */
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  createContext,
  useContext,
  useRef,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useEscapeLayer, useFocusContainment } from "../../escape.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "./button.tsx";
import {
  OverlayContext,
  useOpenState,
  useOverlay,
  useOverlayValue,
  type OpenProps,
} from "./open-state.ts";
import { portalContainer } from "./portal.ts";

const ModalContext = createContext(true);

/**
 * A modal dialog by default. `modal={false}` is for content that opens bb's
 * own pickers outside the plugin (the new-thread composer): the page behind
 * stays clickable for them, while Tab stays inside the dialog and a click
 * outside does not close it.
 */
function Dialog({
  modal = true,
  children,
  ...openProps
}: OpenProps & { modal?: boolean; children: ReactNode }) {
  const [open, setOpen] = useOpenState(openProps);
  const overlay = useOverlayValue(open, setOpen);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={modal}>
      <ModalContext.Provider value={modal}>
        <OverlayContext.Provider value={overlay}>{children}</OverlayContext.Provider>
      </ModalContext.Provider>
    </DialogPrimitive.Root>
  );
}

const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const OVERLAY = "fixed inset-0 z-50 bg-black/50";

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onInteractOutside,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  const modal = useContext(ModalContext);
  const { open, close } = useOverlay();
  const node = useRef<HTMLDivElement>(null);
  // Escape goes through escape.ts, which claims it before bb or Radix see it.
  useEscapeLayer(node, close, { open, modal: true });
  // Off Radix's focus trap, the page behind stays focusable: Tab is kept inside.
  useFocusContainment(node, open && !modal);
  return (
    <DialogPrimitive.Portal container={portalContainer()}>
      {modal ? (
        <DialogPrimitive.Overlay data-slot="dialog-overlay" className={OVERLAY} />
      ) : (
        <div data-slot="dialog-overlay" aria-hidden className={OVERLAY} />
      )}
      <DialogPrimitive.Content
        ref={node}
        data-slot="dialog-content"
        // escape.ts owns Escape; Radix sees only one it left alone, for bb's own pickers.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onEscapeKeyDown?.(event);
        }}
        onInteractOutside={(event) => {
          if (!modal) event.preventDefault();
          onInteractOutside?.(event);
        }}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-2rem)] w-[440px] max-w-[calc(100%-2rem)] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-[10px] border border-solid border-border bg-popover p-4 text-start text-foreground shadow-xl outline-none",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              aria-label="Close"
              className="absolute top-3 right-3 size-7 px-0"
            >
              <Icon name="X" className="size-3.5" aria-hidden />
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex min-w-0 flex-col gap-1 pr-8", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-wrap items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 text-[15px] leading-5 font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("m-0 text-[12px] leading-4 break-words text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
