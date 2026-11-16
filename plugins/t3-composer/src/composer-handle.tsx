import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useComposer, type PluginComposerApi } from "@get-bb/plugin-sdk/app";

/**
 * A holder that is replaced whenever a value its readers show has changed. The handle inside
 * stays the same object and always reads bb's current values.
 */
type HandleRevision = { composer: PluginComposerApi };

const DraftRevisionContext = createContext<HandleRevision | null>(null);
const PickerRevisionContext = createContext<HandleRevision | null>(null);

/**
 * Reads bb's composer once for the whole composer and shares the handle with everything
 * inside.
 *
 * bb re-renders each `useComposer()` caller twice per keystroke, whatever that caller reads:
 * when the host renders the composer, and again when the host republishes its editor. With
 * one caller here, the components inside render only when a value they show has changed, so
 * typing renders the draft's readers once and the pickers not at all.
 */
export function ComposerHandleProvider({ children }: { children: ReactNode }) {
  const composer = useComposer();
  // bb may rebuild the scope object for an unchanged scope, so compare it by value.
  const scope = JSON.stringify(composer.scope);
  const { key, selection } = composer;
  // `text`, `isEmpty` and `attachmentCount` are derived from `draft`.
  const { draft, layout, isRunning, isSubmitting, isSubmittingBlocked, submittingBlockedReason } =
    composer;

  const pickerRevision = useMemo<HandleRevision>(
    () => ({ composer }),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps -- the values are the trigger: a new holder tells the readers one of them changed.
    [composer, key, scope, selection],
  );
  const draftRevision = useMemo<HandleRevision>(
    () => ({ composer }),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps -- as above.
    [
      composer,
      key,
      scope,
      selection,
      draft,
      layout,
      isRunning,
      isSubmitting,
      isSubmittingBlocked,
      submittingBlockedReason,
    ],
  );

  return (
    <PickerRevisionContext.Provider value={pickerRevision}>
      <DraftRevisionContext.Provider value={draftRevision}>
        {children}
      </DraftRevisionContext.Provider>
    </PickerRevisionContext.Provider>
  );
}

function useRevision(context: typeof DraftRevisionContext): PluginComposerApi {
  const revision = useContext(context);
  if (revision === null) throw new Error("No ComposerHandleProvider above this component");
  return revision.composer;
}

/** The composer handle. The caller re-renders when any value on the handle changes. */
export function useComposerHandle(): PluginComposerApi {
  return useRevision(DraftRevisionContext);
}

/**
 * The composer handle for a picker. The caller re-renders only when `selection`, `scope` or
 * `key` changes, so read the handle's other values in event handlers, never while rendering.
 */
export function usePickerComposer(): PluginComposerApi {
  return useRevision(PickerRevisionContext);
}
