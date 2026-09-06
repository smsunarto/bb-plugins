import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  configureInputSchema,
  eventDetailSchema,
  eventInputSchema,
  eventPageSchema,
  eventQuerySchema,
  rawInputSchema,
  rawPageSchema,
  scanInputSchema,
  sessionPageSchema,
  sessionQuerySchema,
  statusSchema,
} from "./schema.ts";

export const traceHostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: statusSchema },
  scan: { input: scanInputSchema, output: statusSchema },
  configureSources: { input: configureInputSchema, output: statusSchema },
  sessions: { input: sessionQuerySchema, output: sessionPageSchema },
  events: { input: eventQuerySchema, output: eventPageSchema },
  event: { input: eventInputSchema, output: eventDetailSchema },
  raw: { input: rawInputSchema, output: rawPageSchema },
});
