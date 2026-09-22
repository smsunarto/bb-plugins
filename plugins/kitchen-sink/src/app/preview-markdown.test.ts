import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { previewMarkdown } from "./preview-markdown.ts";
installDom();
test("resolves image and reference destinations while preserving GFM and code", () => {
  const result = previewMarkdown(
    "![Chart](chart.png)\n\n[Notes][n]\n\n[n]: notes.md\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\n```md\n![Unchanged](chart.png)\n```",
    "https://bb.example/api/v1/file-previews/lease/report.md",
  );
  expect(result).toContain("https://bb.example/api/v1/file-previews/lease/chart.png");
  expect(result).toContain("https://bb.example/api/v1/file-previews/lease/notes.md");
  expect(result).toContain("| A | B |");
  expect(result).toContain("[x] Done");
  expect(result).toContain("```md\n![Unchanged](chart.png)\n```");
});
test("keeps the document and sibling images when a link leaves the preview directory", () => {
  const result = previewMarkdown(
    "# Report\n\nSee [up](../README.md), [remote](https://example.com), and ![Chart](chart.png).\n\n![Outside](../outside.png)",
    "https://bb.example/api/v1/file-previews/lease/a.md",
  );
  expect(result).toContain("# Report");
  expect(result).toContain("[up](../README.md)");
  expect(result).toContain("[remote](https://example.com)");
  expect(result).toContain("![Outside](../outside.png)");
  expect(result).toContain("![Chart](https://bb.example/api/v1/file-previews/lease/chart.png)");
});
