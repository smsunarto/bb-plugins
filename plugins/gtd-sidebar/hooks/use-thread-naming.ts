import { useCallback, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { gtdSidebarRpcContract } from "@/server";

export function useThreadNaming(threadId: string) {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [isNaming, setIsNaming] = useState(false);

  const renameThread = useCallback(async () => {
    if (isNaming) return;
    setIsNaming(true);
    try {
      const result = await rpc.call("renameThread", { threadId });
      if (result.ok) {
        toast.success("Thread renamed", { description: result.title });
      } else {
        toast.error("Could not rename thread", { description: result.error });
      }
    } catch (error) {
      toast.error("Could not rename thread", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsNaming(false);
    }
  }, [isNaming, rpc, threadId]);

  return { isNaming, renameThread };
}
