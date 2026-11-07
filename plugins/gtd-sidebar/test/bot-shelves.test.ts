import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { BotMetadata } from "@smsunarto/bb-plugin-bots/shelf";
import { botShelves } from "../components/inbox/bot-cards";

const bot = (id: string, extra: Partial<BotMetadata> = {}) =>
  ({ id, name: id, sectionId: null, ...extra }) as BotMetadata;

describe("botShelves", () => {
  test("leaves pinned bots out, lists sections in order, then unsectioned bots under Bots", () => {
    const shelves = botShelves(
      [
        bot("dr", { pinned: true }),
        bot("loose"),
        bot("late", { sectionId: "s2" }),
        bot("early", { sectionId: "s1" }),
        bot("orphan", { sectionId: "gone" }),
      ],
      [
        { id: "s2", name: "Later", order: 1 },
        { id: "s1", name: "Research", order: 0 },
      ],
    );
    assert.deepEqual(
      shelves.map((shelf) => [shelf.label, shelf.bots.map((entry) => entry.id)]),
      [
        ["Research", ["early"]],
        ["Later", ["late"]],
        ["Bots", ["loose", "orphan"]],
      ],
    );
  });

  test("drops empty shelves, so everything pinned leaves none", () => {
    assert.deepEqual(botShelves([bot("dr", { pinned: true })], []), []);
  });
});
