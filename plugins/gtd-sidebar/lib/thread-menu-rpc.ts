import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const threadMenuRpcContract = defineRpcContract({
  listThreadMenuSections: {
    input: z.object({}),
    output: z.object({ sections: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  moveThreadToSection: {
    input: z.object({
      threadId: z.string().trim().min(1),
      sectionId: z.string().trim().min(1).nullable(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
});

export function registerThreadMenuRpc(bb: BbPluginApi): void {
  bb.rpc.register(threadMenuRpcContract, {
    async listThreadMenuSections() {
      return { sections: await bb.sdk.threadSections.list() };
    },
    async moveThreadToSection({ threadId, sectionId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.parentThreadId !== null || thread.archivedAt !== null) {
        throw new Error("Only active root threads can move to a section");
      }
      if (sectionId !== null) {
        const sections = await bb.sdk.threadSections.list();
        if (!sections.some((section) => section.id === sectionId)) {
          throw new Error("This section no longer exists");
        }
      }
      if (thread.sectionId !== sectionId) {
        await bb.sdk.threads.update({ threadId, sectionId });
      }
      // Moving out of Pinned follows the built-in sidebar's section action.
      if (thread.pinnedAt !== null) await bb.sdk.threads.unpin({ threadId });
      return { ok: true as const };
    },
  });
}
