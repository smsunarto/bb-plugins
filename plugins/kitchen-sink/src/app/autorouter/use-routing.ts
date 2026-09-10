import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { AutorouterRpcContract } from "../../shared/autorouter/contract.ts";
import { isFollowupSelection } from "./native-controls.ts";
import { composerKey, interceptComposer, routingStatus, subscribeRouting } from "./intercept.ts";

export function useRouting(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  options: { modelRouting: boolean; projectRouting: boolean; followupRouting: boolean },
) {
  const composer = useComposer();
  const rpc = useRpc<AutorouterRpcContract>();
  const scope =
    composer.scope.kind === "new-thread" || composer.scope.kind === "thread"
      ? composer.scope
      : null;
  const key = scope ? composerKey(scope) : "unsupported";
  const status = useSyncExternalStore(subscribeRouting, () => routingStatus(key));
  const [followupSelection, setFollowupSelection] = useState(false);
  const applicable =
    scope?.kind === "new-thread"
      ? options.projectRouting || options.modelRouting
      : scope?.kind === "thread" && options.followupRouting && followupSelection;
  const active = enabled && applicable;
  const latest = useRef({ composer, rpc, enabled: active });
  useLayoutEffect(() => {
    latest.current = { composer, rpc, enabled: active };
  }, [composer, rpc, active]);
  const supported = scope !== null;

  useEffect(() => {
    const form = root.current?.closest<HTMLElement>("[data-promptbox]");
    if (!form || !supported) return;
    const update = () => setFollowupSelection(isFollowupSelection(form));
    update();
    const observer = new MutationObserver(update);
    observer.observe(form, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title"],
    });
    const currentScope = () => {
      const value = latest.current.composer.scope;
      if (value.kind !== "new-thread" && value.kind !== "thread")
        throw new Error("This composer cannot be autorouted.");
      return value;
    };
    const release = interceptComposer({
      root: form,
      scope: currentScope,
      text: () => latest.current.composer.text,
      enabled: () => latest.current.enabled,
      lock: (locked) => latest.current.composer.setInputLock(locked),
      infer: async (selectionTitle) => {
        const scope = currentScope();
        const result = await latest.current.rpc.call("routeAutorouterPrompt", {
          prompt: latest.current.composer.text,
          scope: scope.kind === "thread" ? { ...scope, selectionTitle } : scope,
        });
        return result.decision;
      },
    });
    return () => {
      observer.disconnect();
      release();
    };
  }, [root, supported, key]);
  return { ...status, applicable };
}
