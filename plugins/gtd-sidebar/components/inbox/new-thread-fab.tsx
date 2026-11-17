import { memo } from "react";
import { experimental_Icon as RegistryIcon } from "@get-bb/plugin-sdk/app";
import { Button } from "../ui/button";
import { nativeHaptic } from "../../lib/native-haptics";
import { focusComposeEditorWithKeyboard } from "../../lib/compose-keyboard";

/** Marks the pill; `new-thread-fab-style.ts` hides bb's header New thread while it shows. */
export const NEW_THREAD_FAB_ATTRIBUTE = "data-gtd-new-thread-fab";

/**
 * The phone drawer's New thread: a light pill floating over the list's
 * bottom-left corner, in reach of the thumb. It replaces bb's New thread row
 * in the sidebar header. A tap ticks (BB's iOS app plays the haptic, honoring
 * the device's Haptics switch), opens the composer, and brings up the
 * keyboard in it.
 */
export const NewThreadFab = memo(function NewThreadFab({ onPress }: { onPress: () => void }) {
  return (
    <Button
      {...{ [NEW_THREAD_FAB_ATTRIBUTE]: "" }}
      variant="ghost"
      aria-label="New thread"
      onClick={(event) => {
        nativeHaptic("selection");
        focusComposeEditorWithKeyboard(event.currentTarget.ownerDocument);
        onPress();
      }}
      className="absolute bottom-2 left-3 z-10 h-12 gap-2 rounded-full !bg-foreground px-5 text-[15px] font-semibold !text-background shadow-lg transition-transform active:scale-[0.97] [&_[data-icon-root]]:size-5"
    >
      <RegistryIcon name="Edit" aria-hidden />
      New
    </Button>
  );
});
