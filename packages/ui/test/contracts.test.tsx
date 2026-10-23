import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, BorderedButton, NativeButton, CompactButton } from "../src/button";
import { Input, BorderedInput } from "../src/input";
import { styles } from "../src/styles";
import { cn } from "../src/utils";

describe("shared control compatibility", () => {
  test("Whiteboard button marker and caller overrides survive", () => {
    const html = renderToStaticMarkup(<Button className="h-12">Save</Button>);
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("h-12");
    expect(html).toContain(styles["size-default"]);
  });
  test("GitButler keeps native focus and explicit icon sizing", () => {
    const html = renderToStaticMarkup(<NativeButton>Push</NativeButton>);
    expect(html).not.toContain("focus-visible:outline-none");
    expect(html).not.toContain("focus-visible:ring-1");
    expect(html).toContain(styles["native"]);
  });
  test("GitHub Stack retains its border and input surface", () => {
    expect(renderToStaticMarkup(<BorderedButton variant="outline">Save</BorderedButton>)).toContain(
      styles["bordered"],
    );
    expect(renderToStaticMarkup(<BorderedInput />)).toContain(styles["bordered"]);
    expect(renderToStaticMarkup(<Input />)).toContain(`${styles.input} ${styles.motion}`);
  });
  test("compact controls stay non-submitting and support xs", () => {
    const html = renderToStaticMarkup(<CompactButton size="xs">Close</CompactButton>);
    expect(html).toContain('type="button"');
    expect(html).toContain(styles["size-xs"]);
  });
  test("asChild retains link semantics", () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="#target">Open</a>
      </Button>,
    );
    expect(html).toStartWith("<a ");
    expect(html).not.toContain("<button");
  });
  test("cn resolves conflicting utilities", () => {
    expect(cn("h-8", false, "h-10")).toBe("h-10");
  });
});
