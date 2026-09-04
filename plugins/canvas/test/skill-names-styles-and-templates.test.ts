import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { styleNames, styles } from "../shared/styles.ts";

const skillPath = new URL("../skills/canvas/SKILL.md", import.meta.url);

test("SKILL.md quotes every style summary verbatim", async () => {
  const skill = await readFile(skillPath, "utf8");
  for (const name of styleNames) {
    assert.ok(skill.includes(`\`${name}\``), `${name} is named in SKILL.md`);
    assert.ok(
      skill.includes(styles[name].summary),
      `${name} summary in SKILL.md matches styles.ts`,
    );
  }
});

test("SKILL.md names both templates", async () => {
  const skill = await readFile(skillPath, "utf8");
  for (const file of ["templates/pull-request.canvas.mdx", "templates/issue.canvas.mdx"]) {
    assert.ok(skill.includes(file), `${file} is named in SKILL.md`);
  }
});
