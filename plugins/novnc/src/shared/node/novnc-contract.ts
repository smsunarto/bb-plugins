import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const NOVNC_PORT = 6080;

export const novncHostContract = defineRpcContract({
  checkNovnc: {
    input: z.object({}).strict(),
    output: z
      .object({
        running: z.boolean(),
        detail: z.string().optional(),
      })
      .strict(),
  },
});
