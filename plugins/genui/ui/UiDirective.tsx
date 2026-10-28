// The `::ui{id="…"}` message directive renders UIs stored by the retired
// show_ui tool, so replies written during the pilot keep rendering. New
// replies write ```ui blocks instead (FenceOverlay).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useComposer, useRpc, useSdk, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { compile } from "../core";
import type { rpcContract } from "../server";
import { useAnswerComposers } from "./answerSheet";
import { LiveUi, RenderFailure, type AnswerTarget } from "./LiveUi";
import { useAssetLoader, useAudioLoader, useImageLoader, useLoadedData, useTextLoader } from "./useLoadedData";
import { useReplyIndex, useSuperseded } from "./useSuperseded";
import { useMotionScope } from "./components/motion";

const UI_ID = /^[a-z0-9]{10}$/;

export function UiDirective({ attributes, source, message, openWorkspaceFile }: PluginMessageDirectiveProps) {
  const id = attributes.id;
  if (id === undefined || !UI_ID.test(id)) {
    return (
      <Notice>
        Invalid UI directive: <code className="font-mono">{source}</code>
      </Notice>
    );
  }
  return (
    <StoredUi
      key={id}
      id={id}
      threadId={message.threadId}
      messageId={message.id}
      directive={source}
      openWorkspaceFile={openWorkspaceFile}
    />
  );
}

type Load =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; source: string };

function StoredUi({
  id,
  threadId,
  messageId,
  directive,
  openWorkspaceFile,
}: {
  id: string;
  threadId: string;
  /** The assistant message holding the directive. */
  messageId: string;
  directive: string;
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const composer = useComposer();
  useAnswerComposers(useMemo(() => [composer], [composer]));
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    let live = true;
    rpc.call("get_ui", { id }).then(
      ({ source }) => {
        if (live) setLoad({ status: "ready", source });
      },
      (cause: unknown) => {
        if (live) setLoad({ status: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, id]);
  const source = load.status === "ready" ? load.source : "";
  const compiled = useMemo(() => compile(source), [source]);
  const reply = useReplyIndex(threadId, messageId);
  const answers = useMemo<AnswerTarget>(
    () => ({
      kind: "thread",
      threadId,
      messageId,
      fence: 0,
      reply,
      send: async (text) => {
        await sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
      },
    }),
    [sdk, threadId, messageId, reply],
  );
  const data = useLoadedData({ threadId }, compiled.program);
  const loadImage = useImageLoader({ threadId }, `bb.genui.state:${id}`);
  const readText = useTextLoader({ threadId });
  const loadAudio = useAudioLoader({ threadId });
  const loadAsset = useAssetLoader({ threadId });
  const superseded = useSuperseded(threadId, messageId);
  const motion = useMotionScope();

  switch (load.status) {
    case "loading":
      return (
        <div
          {...motion}
          role="status"
          aria-label="Loading UI"
          className="not-prose my-3 h-28 animate-pulse rounded-lg border border-border bg-surface-recessed"
        />
      );
    case "failed":
      return (
        <Notice>
          UI unavailable ({load.message}): <code className="font-mono">{directive}</code>
        </Notice>
      );
    case "ready":
      return compiled.program === null ? (
        <RenderFailure source={source} diagnostics={compiled.diagnostics} />
      ) : (
        <LiveUi
          program={compiled.program}
          compileDiagnostics={compiled.diagnostics}
          source={source}
          stateKey={`bb.genui.state:${id}`}
          data={data}
          answers={answers}
          openFile={openWorkspaceFile}
          loadImage={loadImage}
          readText={readText}
          loadAudio={loadAudio}
          loadAsset={loadAsset}
          superseded={superseded}
          threadId={threadId}
          blockKey={`bb.genui.state:${id}`}
        />
      );
  }
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="not-prose my-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}
