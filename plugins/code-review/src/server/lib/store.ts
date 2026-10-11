import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  type Pin,
  type PrRef,
  type ReviewRun,
  pinSchema,
  reviewRunSchema,
  sameAccount,
  sameRef,
} from "../../shared/schema.ts";
import { createLocks } from "./lock.ts";

/*
 * Everything the plugin remembers lives in bb's plugin KV. GitHub holds the
 * review itself (drafts sit in the viewer's pending review), so this is only
 * what GitHub has no place for: pins, the reviewer's standing instructions,
 * and which bb threads were started for which subject: a pull request or an
 * unpublished branch (see `subjectKey`).
 *
 *   pins                 Pin[], pin order, at most MAX_PINS
 *   instructions         string
 *   links:<subject>      Link[], newest first, at most MAX_LINKS
 *   thread:<threadId>    the subject a linked thread works on
 *   run:<threadId>       the ReviewRun a review thread reported
 *
 * `<subject>` is lowercased: GitHub owners and repositories are
 * case-insensitive, so `Cli/CLI#1` and `cli/cli#1` share their threads.
 *
 * Writes that read the list they change hold the list's key, so two quick
 * pins, or two threads linked at once, both land.
 *
 * KV outlives the code that wrote it. Records are parsed on the way out, and
 * one saved before a field existed is skipped, so it cannot fail a whole answer.
 */

export const MAX_PINS = 50;
export const MAX_LINKS = 20;

const linkSchema = z.object({
  threadId: z.string(),
  kind: z.enum(["review", "fix"]),
  /** ISO time the thread was started. */
  createdAt: z.string(),
  /** The pull request's head commit when the thread was started. */
  headRefOid: z.string(),
  /** The pull request's base branch when the thread was started. */
  baseRefName: z.string(),
});
export type Link = z.infer<typeof linkSchema>;

/** The items of a stored list that still parse. */
function parsedList<T>(schema: z.ZodType<T>, stored: unknown): T[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export type Store = ReturnType<typeof createStore>;

const linksKey = (subject: string) => `links:${subject.toLowerCase()}`;
const threadKey = (threadId: string) => `thread:${threadId}`;
const runKey = (threadId: string) => `run:${threadId}`;

export function createStore(kv: PluginKvStorage) {
  const withLock = createLocks();
  return {
    async pins(): Promise<Pin[]> {
      return parsedList(pinSchema, await kv.get("pins"));
    },

    /**
     * Pins go to the end of the list, as `account`; pinning twice or
     * unpinning a stranger is a no-op. A pull request is pinned once,
     * whichever account pinned it.
     */
    async setPinned(ref: PrRef, pinned: boolean, account: string): Promise<Pin[]> {
      return withLock("pins", async () => {
        const pins = await this.pins();
        const others = pins.filter((pin) => !sameRef(pin, ref));
        if (!pinned) {
          if (others.length !== pins.length) await kv.set("pins", others);
          return others;
        }
        const held = pins.find((pin) => sameRef(pin, ref));
        if (held) {
          // Pinned again as another account, say after the first signed out: it moves to this one.
          if (held.account !== undefined && sameAccount(held.account, account)) return pins;
          const next = pins.map((pin) => (pin === held ? { ...pin, account } : pin));
          await kv.set("pins", next);
          return next;
        }
        if (pins.length >= MAX_PINS) {
          throw new Error(`You can pin up to ${MAX_PINS} pull requests. Unpin one first.`);
        }
        const next = [...pins, { owner: ref.owner, repo: ref.repo, number: ref.number, account }];
        await kv.set("pins", next);
        return next;
      });
    },

    async instructions(): Promise<string> {
      return (await kv.get<string>("instructions")) ?? "";
    },

    async setInstructions(text: string): Promise<string> {
      const trimmed = text.trim();
      if (trimmed === "") await kv.delete("instructions");
      else await kv.set("instructions", trimmed);
      return trimmed;
    },

    /** Threads started for the subject, newest first. */
    async links(subject: string): Promise<Link[]> {
      return parsedList(linkSchema, await kv.get(linksKey(subject)));
    },

    /**
     * Remembers a thread started for the subject. The oldest links past
     * MAX_LINKS are forgotten along with their reverse lookup and review run.
     */
    async addLink(subject: string, link: Link): Promise<void> {
      await withLock(linksKey(subject), async () => {
        const links = [
          link,
          ...(await this.links(subject)).filter((l) => l.threadId !== link.threadId),
        ];
        await kv.set(linksKey(subject), links.slice(0, MAX_LINKS));
        await kv.set(threadKey(link.threadId), subject);
        await Promise.all(
          links
            .slice(MAX_LINKS)
            .flatMap((dropped) => [
              kv.delete(threadKey(dropped.threadId)),
              kv.delete(runKey(dropped.threadId)),
            ]),
        );
      });
    },

    /** The subject a linked thread works on, and its link. Null for any other thread. */
    async linkForThread(threadId: string): Promise<{ key: string; link: Link } | null> {
      const key = await kv.get<string>(threadKey(threadId));
      if (typeof key !== "string" || key === "") return null;
      const link = (await this.links(key)).find((l) => l.threadId === threadId);
      return link ? { key, link } : null;
    },

    async run(threadId: string): Promise<ReviewRun | null> {
      const parsed = reviewRunSchema.safeParse(await kv.get(runKey(threadId)));
      return parsed.success ? parsed.data : null;
    },

    async setRun(run: ReviewRun): Promise<void> {
      await kv.set(runKey(run.threadId), run);
    },
  };
}
