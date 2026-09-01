import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { useThreadNaming } from "@/hooks/use-thread-naming";

const LABEL = "Generate thread name";

export function RenameThreadAction({ threadId }: PluginThreadHeaderActionProps) {
  const { isNaming, renameThread } = useThreadNaming(threadId);

  return (
    <button
      type="button"
      aria-label={LABEL}
      title={isNaming ? "Generating thread name" : LABEL}
      disabled={isNaming}
      onClick={() => void renameThread()}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-wait disabled:opacity-60"
    >
      <Icon
        name={isNaming ? "Loading" : "Edit"}
        className={`size-4 ${isNaming ? "animate-spin" : ""}`}
        aria-hidden
      />
    </button>
  );
}
