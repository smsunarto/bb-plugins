import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, BorderedButton, NativeButton, CompactButton } from "../src/button";
import { Input, BorderedInput } from "../src/input";
import { styles } from "../src/styles";
import { cn } from "../src/utils";
import { Card, CardHeader, CardTitle } from "../src/card";
import { Separator } from "../src/separator";
import { Badge } from "../src/badge";
import { surface } from "../src/surface";

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

describe("shared surfaces", () => {
  test("Card parts carry one shared edge and accept caller classes", () => {
    const html = renderToStaticMarkup(
      <Card className="mt-2">
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
      </Card>,
    );
    expect(html).toContain(styles.card);
    expect(html).toContain("mt-2");
    expect(html).toContain('data-slot="card-title"');
  });
  test("a decorative Separator is hidden from assistive technology", () => {
    expect(renderToStaticMarkup(<Separator />)).toContain('role="none"');
    const labelled = renderToStaticMarkup(<Separator orientation="vertical" decorative={false} />);
    expect(labelled).toContain('role="separator"');
    expect(labelled).toContain('aria-orientation="vertical"');
  });
  test("Badge variants map to shared classes", () => {
    expect(renderToStaticMarkup(<Badge variant="count">3</Badge>)).toContain(styles["badge-count"]);
    expect(surface.hairline).toBe(styles.hairline);
  });
});
