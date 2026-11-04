import { z } from "zod";

/** The catalog editor's RPC methods. Types only cross into the app bundle. */

const origin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("authored") }),
  z.object({ kind: z.literal("imported"), from: z.string() }),
]);

const publishReport = z.object({
  linked: z.array(z.string()),
  relinked: z.array(z.string()),
  unlinked: z.array(z.string()),
  unchanged: z.number(),
  agentsMd: z.enum(["linked", "relinked", "unlinked", "unchanged", "none", "conflict"]),
  conflicts: z.array(z.string()),
  failed: z.array(z.object({ name: z.string(), error: z.string() })),
  deferred: z.array(z.string()),
  removed: z.number(),
});

/** What a publish did, or why it could not run. Never a stale earlier report. */
export const publishOutcome = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    at: z.number(),
    report: publishReport,
    problems: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  z.object({ ok: z.literal(false), at: z.number(), error: z.string() }),
]);
export type PublishOutcome = z.infer<typeof publishOutcome>;

export const catalogListing = z.object({
  revision: z.number(),
  docs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      origin,
      characters: z.number(),
      sha256: z.string(),
    }),
  ),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      origin,
      treeSha: z.string(),
      files: z.array(
        z.object({
          path: z.string(),
          executable: z.boolean(),
          size: z.number(),
          text: z.boolean(),
        }),
      ),
    }),
  ),
  /** Deleted skills and docs, kept so they can be restored; import skips them. */
  deleted: z.array(
    z.object({ kind: z.enum(["skill", "doc"]), key: z.string(), name: z.string(), at: z.number() }),
  ),
  /** The latest publish since this plugin loaded, or null before the first one. */
  published: publishOutcome.nullable(),
});
export type CatalogListing = z.infer<typeof catalogListing>;

export const fileTarget = z.union([
  z.object({ doc: z.string().min(1) }).strict(),
  z.object({ skill: z.string().min(1), path: z.string().min(1).max(512) }).strict(),
]);
export type FileTarget = z.infer<typeof fileTarget>;

export const catalogFile = z.object({
  /** Null when the file is not editable text. */
  content: z.string().nullable(),
  /** Null when the file does not exist yet; saving creates it. */
  sha256: z.string().nullable(),
  size: z.number(),
  executable: z.boolean(),
});

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const name = z.string().trim().min(1).max(80);

export const catalogChange = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("saveFile"),
    skill: z.string(),
    path: z.string(),
    content: z.string(),
    expectedSha256: sha.nullable(),
  }),
  z.object({
    op: z.literal("deleteFile"),
    skill: z.string(),
    path: z.string(),
    expectedSha256: sha,
  }),
  z.object({ op: z.literal("createSkill"), name: z.string(), description: z.string() }),
  z.object({ op: z.literal("deleteSkill"), name: z.string(), expectedTreeSha: sha }),
  z.object({ op: z.literal("setSkillEnabled"), name: z.string(), enabled: z.boolean() }),
  z.object({ op: z.literal("saveDoc"), id: z.string(), body: z.string(), expectedSha256: sha }),
  z.object({ op: z.literal("createDoc"), name }),
  z.object({ op: z.literal("renameDoc"), id: z.string(), name }),
  z.object({ op: z.literal("setDocEnabled"), id: z.string(), enabled: z.boolean() }),
  z.object({ op: z.literal("deleteDoc"), id: z.string(), expectedSha256: sha }),
  z.object({ op: z.literal("restore"), kind: z.enum(["skill", "doc"]), key: z.string() }),
  z.object({ op: z.literal("forget"), kind: z.enum(["skill", "doc"]), key: z.string() }),
]);
export type CatalogChange = z.infer<typeof catalogChange>;

/** A stored change: the new hash of what was written, or the id of what was created. */
const stored = z.object({
  outcome: z.literal("saved"),
  revision: z.number(),
  sha256: z.string().optional(),
  treeSha: z.string().optional(),
  id: z.string().optional(),
  warnings: z.array(z.string()),
});
export const changeResult = z.discriminatedUnion("outcome", [
  stored,
  z.object({ outcome: z.literal("conflict"), message: z.string() }),
  z.object({ outcome: z.literal("invalid"), errors: z.array(z.string()) }),
]);
export type ChangeResult = z.infer<typeof changeResult>;

/** The RPC result: a stored change also carries what publishing it did. */
export const changeResponse = z.discriminatedUnion("outcome", [
  stored.extend({ published: publishOutcome }),
  z.object({ outcome: z.literal("conflict"), message: z.string() }),
  z.object({ outcome: z.literal("invalid"), errors: z.array(z.string()) }),
]);

export const shadowCheck = z.discriminatedUnion("checked", [
  z.object({
    checked: z.literal(true),
    /** Catalog skills that hide, or are hidden by, a skill bb delivers, with its owner. */
    shadows: z.array(z.object({ name: z.string(), owner: z.string() })),
  }),
  z.object({ checked: z.literal(false), error: z.string() }),
]);

export const catalogContracts = {
  catalog: { input: z.null(), output: catalogListing },
  catalogShadows: { input: z.null(), output: shadowCheck },
  catalogFile: { input: fileTarget, output: catalogFile },
  changeCatalog: { input: catalogChange, output: changeResponse },
  publishCatalog: { input: z.null(), output: publishOutcome },
};
