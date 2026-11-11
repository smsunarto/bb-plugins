import { describe, expect, test } from "vitest";
import { CHANGED_GROUP, resolveGuide, UNGUIDED_GROUP, viewedAtHead, type Guide } from "./guide.ts";
import { changeKeySchema } from "./ids.ts";
import type { ChangeFile } from "./review.ts";

const KEY = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:scott/guide");
const OLD = "a0a0a0a";
const NEW = "b1b1b1b";
const blob = (tag: string) => tag.repeat(40).slice(0, 40);

function file(path: string, tag: string | null, kind: ChangeFile["kind"] = "modified"): ChangeFile {
  return {
    path,
    kind,
    previousPath: null,
    additions: 1,
    deletions: 0,
    binary: false,
    blob: tag === null ? null : blob(tag),
  };
}

const GUIDE: Guide = {
  changeKey: KEY,
  revision: OLD,
  summary: "Two groups; the risk is in the client.",
  groups: [
    {
      id: "client",
      title: "The client",
      intro: "Read client.ts first.",
      files: [
        { path: "src/client.ts", blob: blob("1"), note: "The new client." },
        { path: "src/host.ts", blob: blob("2"), note: null },
      ],
    },
    {
      id: "tests",
      title: "Tests",
      intro: "",
      files: [{ path: "test/client.test.ts", blob: blob("3"), note: null }],
    },
  ],
};

/** Each group as `id: path, path`. */
const shape = (resolved: ReturnType<typeof resolveGuide>) =>
  resolved.groups.map((group) => `${group.id}: ${group.files.map((f) => f.path).join(", ")}`);

describe("resolveGuide", () => {
  const cases: {
    name: string;
    guide: Guide | null;
    files: ChangeFile[];
    head: string;
    source: string;
    groups: string[];
  }[] = [
    {
      name: "no guide: the derived order, generated files and lockfiles last",
      guide: null,
      files: [
        file("pnpm-lock.yaml", "9"),
        file("src/b.ts", "2"),
        file("dist/app.min.js", "8"),
        file("src/a.ts", "1"),
      ],
      head: NEW,
      source: "derived",
      groups: ["files: src/a.ts, src/b.ts", "generated: dist/app.min.js, pnpm-lock.yaml"],
    },
    {
      name: "the guide's head: as written",
      guide: GUIDE,
      files: [
        file("test/client.test.ts", "3"),
        file("src/host.ts", "2"),
        file("src/client.ts", "1"),
      ],
      head: OLD,
      source: "guide",
      groups: ["client: src/client.ts, src/host.ts", "tests: test/client.test.ts"],
    },
    {
      name: "the guide's head with a file it left out: that file follows, derived",
      guide: GUIDE,
      files: [
        file("src/client.ts", "1"),
        file("src/host.ts", "2"),
        file("test/client.test.ts", "3"),
        file("README.md", "4"),
      ],
      head: OLD,
      source: "guide",
      groups: [
        "client: src/client.ts, src/host.ts",
        "tests: test/client.test.ts",
        `${UNGUIDED_GROUP}: README.md`,
      ],
    },
    {
      name: "a later head: unchanged blobs carry forward, changed and new files regroup",
      guide: GUIDE,
      files: [
        file("src/client.ts", "5"),
        file("src/host.ts", "2"),
        file("test/client.test.ts", "3"),
        file("src/new.ts", "6", "added"),
      ],
      head: NEW,
      source: "carried",
      groups: [
        "client: src/host.ts",
        "tests: test/client.test.ts",
        `${CHANGED_GROUP}: src/client.ts, src/new.ts`,
      ],
    },
    {
      name: "a later head that removed a file from the change: it drops out, and so does its emptied group",
      guide: GUIDE,
      files: [file("src/client.ts", "1"), file("src/host.ts", "2")],
      head: NEW,
      source: "carried",
      groups: ["client: src/client.ts, src/host.ts"],
    },
    {
      name: "a later head that deleted a file: the deletion is a change, not a carry",
      guide: GUIDE,
      files: [
        file("src/client.ts", "1"),
        file("src/host.ts", null, "deleted"),
        file("test/client.test.ts", "3"),
      ],
      head: NEW,
      source: "carried",
      groups: [
        "client: src/client.ts",
        "tests: test/client.test.ts",
        `${CHANGED_GROUP}: src/host.ts`,
      ],
    },
    {
      name: "a later head whose source gave no blobs: nothing can be proven unchanged",
      guide: GUIDE,
      files: [
        { ...file("src/client.ts", "1"), blob: undefined },
        { ...file("src/host.ts", "2"), blob: undefined },
      ],
      head: NEW,
      source: "carried",
      groups: [`${CHANGED_GROUP}: src/client.ts, src/host.ts`],
    },
    {
      name: "a guide naming one file twice places it once",
      guide: {
        ...GUIDE,
        groups: [
          GUIDE.groups[0]!,
          { id: "again", title: "Again", intro: "", files: [GUIDE.groups[0]!.files[0]!] },
        ],
      },
      files: [file("src/client.ts", "1"), file("src/host.ts", "2")],
      head: OLD,
      source: "guide",
      groups: ["client: src/client.ts, src/host.ts"],
    },
  ];

  test.each(cases)("$name", ({ guide, files, head, source, groups }) => {
    const resolved = resolveGuide(guide, files, head);
    expect(resolved.source).toBe(source);
    expect(shape(resolved)).toEqual(groups);
  });

  test("notes and intros come from the guide; derived groups have none", () => {
    const resolved = resolveGuide(
      GUIDE,
      [file("src/client.ts", "1"), file("src/new.ts", "6")],
      NEW,
    );
    expect(resolved.summary).toBe(GUIDE.summary);
    expect(resolved.groups[0]).toMatchObject({
      intro: "Read client.ts first.",
      derived: false,
      files: [{ path: "src/client.ts", note: "The new client." }],
    });
    expect(resolved.groups[1]).toMatchObject({ intro: null, derived: true });
  });
});

describe("viewedAtHead", () => {
  test("a mark counts only for the blob it was made on", () => {
    const files = [file("a.ts", "1"), file("b.ts", "2"), file("c.ts", null, "deleted")];
    const viewed = [
      { path: "a.ts", blob: blob("1") },
      { path: "b.ts", blob: blob("9") },
      { path: "c.ts", blob: "deleted" },
    ];
    expect([...viewedAtHead(files, viewed)].toSorted()).toEqual(["a.ts", "c.ts"]);
  });

  test("a file whose blob is unknown is never viewed", () => {
    expect(
      viewedAtHead([{ ...file("a.ts", "1"), blob: undefined }], [{ path: "a.ts", blob: blob("1") }])
        .size,
    ).toBe(0);
  });
});
