import { createHash } from "node:crypto";
import { publishFindings } from "../server/command/publish.ts";
import type { CatalogChange, CatalogListing, FileTarget, PublishOutcome } from "./contract.ts";
import { editableText } from "./edit-rules.ts";
import type { CatalogContext } from "./import.ts";
import { deliveredSkills } from "./shadow.ts";

/** How long the editor waits for bb to list its skills before showing the check as not done. */
const SHADOW_TIMEOUT_MS = 10_000;
/** How long a change waits for its publish; a slower publish keeps running in the background. */
const PUBLISH_WAIT_MS = 15_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The catalog editor's RPC handlers. */
export function catalogHandlers(ctx: CatalogContext) {
  const outcome = (report: Parameters<typeof publishFindings>[0], at: number): PublishOutcome => ({
    ok: true,
    at,
    report,
    ...publishFindings(report, ctx.store.state().rules),
  });

  async function publishNow(): Promise<PublishOutcome> {
    try {
      return outcome(await ctx.publisher.run(), Date.now());
    } catch (error) {
      return { ok: false, at: Date.now(), error: (error as Error).message };
    }
  }

  /** A publish, or how long it has run when it is slower than a request should wait. */
  async function publishWithin(): Promise<PublishOutcome> {
    try {
      return await within(publishNow(), PUBLISH_WAIT_MS, "Publishing");
    } catch (error) {
      return {
        ok: false,
        at: Date.now(),
        error: `${(error as Error).message}; it continues in the background`,
      };
    }
  }

  function lastPublish(): PublishOutcome | null {
    const last = ctx.publisher.last();
    if (last === null) return null;
    return "error" in last
      ? { ok: false, at: last.at, error: last.error }
      : outcome(last.report, last.at);
  }

  /** Why a new skill's name would clash with one bb delivers, or null; a failed check never blocks. */
  async function shadowError(name: string): Promise<string | null> {
    try {
      const owner = (
        await within(deliveredSkills(ctx.bb), SHADOW_TIMEOUT_MS, "Listing skills")
      ).owners.get(name);
      return owner ? `${name} would hide the ${name} skill from ${owner}; pick another name` : null;
    } catch {
      return null;
    }
  }

  return {
    catalog: (): CatalogListing => ({ ...ctx.catalog.listing(), published: lastPublish() }),

    async catalogShadows() {
      try {
        const { owners } = await within(
          deliveredSkills(ctx.bb),
          SHADOW_TIMEOUT_MS,
          "Listing skills",
        );
        const shadows = ctx.catalog
          .publishable()
          .filter((s) => owners.has(s.name))
          .map((s) => ({ name: s.name, owner: owners.get(s.name)! }));
        return { checked: true as const, shadows };
      } catch (error) {
        return { checked: false as const, error: (error as Error).message };
      }
    },

    catalogFile(target: FileTarget) {
      const file = ctx.catalog.file(target);
      if (file === null && "doc" in target)
        throw new Error("This doc is not in the catalog; it may have been deleted.");
      // A missing skill file opens empty, and saving creates it.
      if (file === null) return { content: "", sha256: null, size: 0, executable: false };
      return {
        content: editableText(file.bytes),
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        size: file.bytes.length,
        executable: file.executable,
      };
    },

    async changeCatalog(change: CatalogChange) {
      if (change.op === "createSkill") {
        const error = await shadowError(change.name.trim());
        if (error) return { outcome: "invalid" as const, errors: [error] };
      }
      const result = ctx.catalog.change(change, "editor");
      if (result.outcome !== "saved") return result;
      return { ...result, published: await publishWithin() };
    },

    publishCatalog: () => publishWithin(),
  };
}
