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
  status: { experimental_retryable: true, input: z.object({}).strict(), output: statusSchema },
  scan: { input: scanInputSchema, output: statusSchema },
  configureSources: { input: configureInputSchema, output: statusSchema },
  sessions: { experimental_retryable: true, input: sessionQuerySchema, output: sessionPageSchema },
  events: { experimental_retryable: true, input: eventQuerySchema, output: eventPageSchema },
  event: { experimental_retryable: true, input: eventInputSchema, output: eventDetailSchema },
  raw: { experimental_retryable: true, input: rawInputSchema, output: rawPageSchema },
});
