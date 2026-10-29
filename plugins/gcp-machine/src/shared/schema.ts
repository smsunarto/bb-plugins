import { z } from "zod";

const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const targetSchema = z
  .object({
    project: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
    zone: name,
    instance: name,
    instanceId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  })
  .strict();
export const accessSchema = z
  .object({
    gcloudPath: z.string().min(1).max(1024),
    account: z.string().max(254),
    sshUser: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  })
  .strict();
export const resourceSchema = targetSchema.extend({
  controllerHostId: z.string().max(128),
  access: accessSchema,
  key: z.string().min(1),
});
/** Every value of Google's `Instance.status` enum, from the compute v1 discovery document. */
export const vmStatusSchema = z.enum([
  "DEPROVISIONING",
  "PENDING",
  "PENDING_STOP",
  "PROVISIONING",
  "REPAIRING",
  "RUNNING",
  "STAGING",
  "STOPPED",
  "STOPPING",
  "SUSPENDED",
  "SUSPENDING",
  "TERMINATED",
]);
export const instanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: vmStatusSchema,
  disks: z.array(z.object({ type: z.string(), boot: z.boolean().optional() })).min(1),
});
const identity = { id: z.string(), name: z.string() };
const presentVmSchema = z
  .object({
    kind: z.literal("present"),
    ...identity,
    status: vmStatusSchema,
    persistentDisksOnly: z.boolean(),
  })
  .strict();
/** The pinned VM as Google reports it, or `missing` once the pinned numeric ID answers 404. */
export const inspectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing"), ...identity }).strict(),
  presentVmSchema,
]);
export const powerResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("gone") }).strict(),
  z.object({ outcome: z.literal("completed"), vm: presentVmSchema }).strict(),
  z.object({ outcome: z.literal("failed"), error: z.string() }).strict(),
  z.object({ outcome: z.literal("not-submitted"), error: z.string() }).strict(),
]);
export type Target = z.infer<typeof targetSchema>;
export type Access = z.infer<typeof accessSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type VmStatus = z.infer<typeof vmStatusSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;
export const PROVIDER_ID = "gcp-machine";
export const IDLE_MS = 60 * 60 * 1000;
