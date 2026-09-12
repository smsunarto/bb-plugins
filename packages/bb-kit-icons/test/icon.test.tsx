import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon, ICON_NAMES } from "../src/icon.tsx";

test("renders an svg tagged with the icon name", () => {
  const html = renderToStaticMarkup(<Icon name="X" className="h-4 w-4" aria-label="Close" />);
  expect(html.startsWith("<svg")).toBe(true);
  expect(html).toContain('data-icon="X"');
  expect(html).toContain('class="h-4 w-4"');
  expect(html).toContain('aria-label="Close"');
});

test("every mapped name renders", () => {
  for (const name of ICON_NAMES) {
    expect(renderToStaticMarkup(<Icon name={name} />)).toContain("<path");
  }
});
