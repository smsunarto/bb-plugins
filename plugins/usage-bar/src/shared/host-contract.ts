import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The server reads quota and pushes the whole menu to every connected host. The
 * host entry draws it on macOS and answers `unsupported` elsewhere, so the server
 * stops calling that host.
 */
export const menuHostContract = defineRpcContract({
  render: {
    input: z.object({
      // The server's MenuSnapshot. The host only forwards it to the helper, and
      // test/wire.test.ts checks that the helper decodes it.
      snapshot: z.custom<object>((value) => typeof value === "object" && value !== null),
      refreshing: z.boolean(),
    }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok") }),
      z.object({ status: z.literal("unsupported") }),
      z.object({ status: z.literal("needs-configuration"), message: z.string() }),
    ]),
  },
});

/** Menu commands that need the server: reading quota again. */
export const menuHostSignals = {
  menu: { payload: z.object({ type: z.enum(["menuOpened", "refresh"]) }) },
};
