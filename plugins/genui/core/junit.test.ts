import { describe, expect, it } from "vitest";
import { LIMITS } from "./catalog";
import { JUnitError, parseXml, readJUnit } from "./junit";

function refusal(source: string): string {
  try {
    readJUnit(source);
  } catch (error) {
    if (error instanceof JUnitError) return error.message;
    throw error;
  }
  throw new Error("expected the report to be refused");
}

const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="pytest tests">
  <testsuite name="pytest" errors="1" failures="1" skipped="2" tests="5" time="0.412">
    <testcase classname="tests.test_api" name="test_list_users" time="0.004" />
    <testcase classname="tests.test_api" name="test_create_user" file="tests/test_api.py" line="18" time="0.031">
      <failure message="assert 201 == 400">def test_create_user(client):
&gt;       assert response.status_code == 400
E       assert 201 == 400

tests/test_api.py:22: AssertionError</failure>
      <system-out><![CDATA[POST /users -> 201 <ok>]]></system-out>
    </testcase>
    <testcase classname="tests.test_db" name="test_migrate" time="0.2">
      <error message="failed on setup with &quot;OperationalError&quot;" type="sqlalchemy.exc.OperationalError" />
    </testcase>
    <testcase classname="tests.test_db" name="test_vacuum" time="0">
      <skipped type="pytest.skip" message="needs postgres">tests/test_db.py:40: needs postgres</skipped>
    </testcase>
    <testcase classname="tests.test_db" name="test_&#x1F600;_name">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

describe("readJUnit", () => {
  it("reads a pytest report: failures, errors and skips with their messages and output", () => {
    expect(readJUnit(PYTEST)).toEqual([
      { name: "test_list_users", status: "passed", suite: "tests.test_api", ms: 4 },
      {
        name: "test_create_user",
        status: "failed",
        suite: "tests.test_api",
        file: "tests/test_api.py",
        line: 18,
        ms: 31,
        message:
          "def test_create_user(client):\n>       assert response.status_code == 400\nE       assert 201 == 400\n\ntests/test_api.py:22: AssertionError",
        output: "POST /users -> 201 <ok>",
      },
      { name: "test_migrate", status: "error", suite: "tests.test_db", ms: 200, message: 'failed on setup with "OperationalError"' },
      { name: "test_vacuum", status: "skipped", suite: "tests.test_db", ms: 0, message: "tests/test_db.py:40: needs postgres" },
      { name: "test_😀_name", status: "skipped", suite: "tests.test_db" },
    ]);
  });

  it("takes a lone testsuite root and inherits nested suite names and files", () => {
    expect(
      readJUnit(`<testsuite name="outer" file="src/a.test.ts">
  <testsuite name="inner"><testcase name="a" /></testsuite>
  <testcase name="b" classname="Cls" />
</testsuite>`),
    ).toEqual([
      { name: "a", status: "passed", suite: "inner", file: "src/a.test.ts" },
      { name: "b", status: "passed", suite: "Cls", file: "src/a.test.ts" },
    ]);
  });

  it("keeps the trace and the message when the body does not repeat it", () => {
    const [test] = readJUnit(
      `<testsuite><testcase name="t"><failure message="expected 1" type="AssertionFailedError">at com.x.T.t(T.java:9)</failure></testcase></testsuite>`,
    ) as Record<string, unknown>[];
    expect(test.message).toBe("expected 1\n\nat com.x.T.t(T.java:9)");
  });

  it("refuses XML that is not a JUnit report, saying what it is", () => {
    expect(refusal(`<?xml version="1.0"?><project><modelVersion>4</modelVersion></project>`)).toBe(
      "only JUnit test reports are read from .xml files; this one's root is <project>, not <testsuites> or <testsuite>",
    );
  });

  it("refuses DOCTYPEs, so entity declarations can never expand", () => {
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>
<testsuites><testcase name="&lol2;" /></testsuites>`;
    expect(refusal(laughs)).toBe("line 2: DOCTYPE and other declarations are not read; a JUnit report needs none");
    expect(refusal(`<testsuites><testcase name="&lol;" /></testsuites>`)).toBe(
      "line 1: the entity &lol; is not one XML predefines",
    );
  });

  it("reports malformed XML with its line", () => {
    expect(refusal("<testsuites>\n<testsuite>\n</testsuites>")).toBe("line 3: </testsuites> closes <testsuite>");
    expect(refusal("<testsuites>\n<testcase name='a'>")).toBe("line 2: <testcase> never closes");
    expect(refusal("<testsuites>\nAT&T</testsuites>")).toBe('line 2: a "&" that starts no entity (write &amp;)');
    expect(refusal('<testsuites><testcase name="a" name="b"/></testsuites>')).toBe("line 1: <testcase> repeats the attribute name");
    expect(refusal("<testsuites/><testsuites/>")).toBe("line 1: a second root element");
    expect(refusal("<testsuites>1 < 2</testsuites>")).toBe('line 1: a "<" that starts no tag (write &lt;)');
    expect(refusal("<testsuites><![CDATA[x</testsuites>")).toBe("line 1: a CDATA section never closes");
    expect(refusal("&#0;")).toBe("line 1: text before the root element");
    expect(refusal("")).toBe("the file has no XML element");
  });

  it("refuses nesting deep enough to matter", () => {
    expect(refusal(`<testsuites>${"<testsuite>".repeat(100)}`)).toBe("line 1: elements are nested more than 64 deep");
  });

  it("returns suites when there are more tests than one list holds", () => {
    const cases = (suite: string, count: number) =>
      Array.from({ length: count }, (_, i) => `<testcase classname="${suite}" name="t${i}"/>`).join("");
    const groups = readJUnit(`<testsuites><testsuite>${cases("a", LIMITS.listLength + 5)}${cases("b", 3)}</testsuite></testsuites>`) as {
      suite: string;
      tests: unknown[];
    }[];
    expect(groups.map((group) => [group.suite, group.tests.length])).toEqual([
      ["a", LIMITS.listLength],
      ["a", 5],
      ["b", 3],
    ]);
  });
});

describe("parseXml", () => {
  it("skips comments and processing instructions and joins text around CDATA", () => {
    const root = parseXml(`\uFEFF<?xml version="1.0"?><!-- c --><a x='1 &lt; 2'>one <![CDATA[<two>]]> &#65;<?pi x?></a><!-- end -->`);
    expect(root.name).toBe("a");
    expect(root.attributes.get("x")).toBe("1 < 2");
    expect(root.text).toBe("one <two> A");
  });
});
