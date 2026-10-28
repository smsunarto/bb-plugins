import { describe, expect, it } from "vitest";
import { processPartialHtml } from "./partialHtml";

describe("processPartialHtml", () => {
  it("cuts an unfinished tag or entity at the end", () => {
    expect(processPartialHtml("<div><p>Orbit</p><butt").body).toBe("<div><p>Orbit</p>");
    expect(processPartialHtml('<div class="card" data-x="a').body).toBe("");
    expect(processPartialHtml("<p>Fish &amp; chips &am").body).toBe("<p>Fish &amp; chips ");
  });

  it("drops scripts, finished or not, and never shows their text", () => {
    expect(processPartialHtml("<p>a</p><script>if (a<b) start()</script><p>b</p>").body).toBe("<p>a</p><p>b</p>");
    expect(processPartialHtml("<p>a</p><script>const x = '<p>not markup</p>'").body).toBe("<p>a</p>");
    expect(processPartialHtml('<p>a</p><script src="x').body).toBe("<p>a</p>");
  });

  it("keeps complete style blocks wherever they are and drops an unfinished one", () => {
    const head = "<!doctype html><html><head><style>.a{color:red}</style><title>T</title></head>";
    const done = processPartialHtml(`${head}<body><style media="print">.b{}</style><p class="a">x</p><style>.c{color:`);
    expect(done.css).toBe(".a{color:red}\n.b{}");
    expect(done.body).toBe('<p class="a">x</p>');
  });

  it("shows only the body once there is one, and nothing from the head before it", () => {
    expect(processPartialHtml('<html><head><title>Orbit</title></head><body class="x"><main>Hi</main></body></html>').body).toBe(
      "<main>Hi</main>",
    );
    expect(processPartialHtml("<!doctype html><html><head><title>Orbit</title><meta charset=utf-8>").body).toBe("");
    expect(processPartialHtml("<!doctype html><html><head><title>Orb").body).toBe("");
  });

  it("takes a fragment written without a body as it is", () => {
    expect(processPartialHtml("<!-- note --><section><h1>Hi</h1><!-- unfinished").body).toBe("<section><h1>Hi</h1>");
  });
});
