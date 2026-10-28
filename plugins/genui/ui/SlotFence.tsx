// Renderer for BB's experimental_codeFenceRenderer slot (get-bb/bb#5387).
import type { ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import { Fence, useThreadActions, type FenceLanguage } from "./Fence";

export const FENCE_LANGUAGES: readonly FenceLanguage[] = ["ui", "app"];

export function SlotFence({ code, language, status, index, message, Original }: ExperimentalCodeFenceRendererProps) {
  const actions = useThreadActions();
  if (language !== "ui" && language !== "app") return <Original />;
  // Interrupted HTML remains source: never execute a document without its closing fence.
  if (language === "app" && status === "unclosed") return <Original />;
  return (
    <div data-genui-fence="" data-genui-renderer="slot">
      <Fence
        language={language}
        code={code}
        complete={status !== "streaming"}
        stateKey={`bb.genui.state:${message.id}#${language}#${index}`}
        threadId={message.threadId}
        messageId={message.id}
        fence={index}
        actions={actions}
      />
    </div>
  );
}
