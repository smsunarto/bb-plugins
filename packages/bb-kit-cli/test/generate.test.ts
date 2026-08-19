import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMigration,
  addModule,
  addOperation,
  addPanel,
  checkProject,
  initializeProject,
  inspectProject,
  readLock,
} from "../src/index.js";
import { repositoryRoot } from "./helpers.js";

const roots: string[] = [];

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-cli-"));
  roots.push(root);
  initializeProject(root, {
    kind: "fullstack",
    packageName: "@acme/bb-plugin-example",
    syncTypes: false,
    install: false,
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bb-kit generation", () => {
  it("initializes additively and idempotently", () => {
    const root = temporaryProject();
    const before = readFileSync(join(root, "plugin/server.ts"), "utf8");
    expect(readFileSync(join(root, "test/scaffold.test.ts"), "utf8")).toContain('from "node:test"');
    const testResult = spawnSync("bun", ["test"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(testResult.status).toBe(0);
    const second = initializeProject(root, {
      kind: "fullstack",
      syncTypes: false,
      install: false,
    });
    expect(second).toEqual([]);
    expect(readFileSync(join(root, "plugin/server.ts"), "utf8")).toBe(before);
  });

  it("adds a complete typed operation slice and locks its wire identity", () => {
    const root = temporaryProject();
    addModule(root, "approvals");
    addOperation(root, "approvals.get", "query");

    const lock = readLock(root);
    expect(lock.operations["approvals.get"]?.rpcMethod).toBe("approvals_get");
    expect(readFileSync(join(root, "plugin/server.ts"), "utf8")).toContain("installApprovals(bb)");
    expect(
      readFileSync(join(root, "plugin/modules/approvals/generated/operations.ts"), "utf8"),
    ).toContain('wireMethod: "approvals_get"');
    expect(readFileSync(join(root, "plugin/modules/approvals/service.ts"), "utf8")).toContain(
      "TODO: implement approvals.get",
    );
    expect(checkProject(root)).toEqual([]);

    const server = readFileSync(join(root, "plugin/server.ts"), "utf8");
    expect(addModule(root, "approvals")).toEqual([]);
    expect(addOperation(root, "approvals.get", "query")).toEqual([]);
    expect(readFileSync(join(root, "plugin/server.ts"), "utf8")).toBe(server);
  });

  it("reports discovered modules and operations", () => {
    const root = temporaryProject();
    addOperation(root, "reports.refresh", "command", "mutating");
    const info = inspectProject(root);
    expect(info.modules).toEqual([
      {
        name: "reports",
        operations: [
          {
            identity: "reports.refresh",
            kind: "command",
            risk: "mutating",
            rpcMethod: "reports_refresh",
            input: { mode: "none" },
            metadataError: null,
          },
        ],
        migrations: [],
        surfaces: [],
        storage: null,
      },
    ]);
  });

  it("discovers only direct named noInput imports as no-input", () => {
    const aliasedRoot = temporaryProject();
    addOperation(aliasedRoot, "reports.get", "query");
    writeFileSync(
      join(aliasedRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import { defineOperation, noInput as none } from "@bb-kit/core/operations";',
        'import { z } from "zod";',
        "export default defineOperation({",
        '  kind: "query",',
        "  input: none,",
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(inspectProject(aliasedRoot).modules[0]?.operations[0]).toEqual(
      expect.objectContaining({ input: { mode: "none" }, metadataError: null }),
    );

    const namespaceRoot = temporaryProject();
    addOperation(namespaceRoot, "reports.get", "query");
    writeFileSync(
      join(namespaceRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import * as kit from "@bb-kit/core/operations";',
        'import { z } from "zod";',
        "export default kit.defineOperation({",
        '  kind: "query",',
        "  input: kit.noInput,",
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(checkProject(namespaceRoot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BBK210" })]),
    );

    const reexportRoot = temporaryProject();
    addOperation(reexportRoot, "reports.get", "query");
    writeFileSync(
      join(reexportRoot, "plugin/no-input.ts"),
      'export { noInput } from "@bb-kit/core/operations";\n',
    );
    writeFileSync(
      join(reexportRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import { defineOperation } from "@bb-kit/core/operations";',
        'import { noInput } from "../../../no-input.js";',
        'import { z } from "zod";',
        "export default defineOperation({",
        '  kind: "query",',
        "  input: noInput,",
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(checkProject(reexportRoot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BBK210" })]),
    );

    const localAliasRoot = temporaryProject();
    addOperation(localAliasRoot, "reports.get", "query");
    writeFileSync(
      join(localAliasRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import { defineOperation, noInput } from "@bb-kit/core/operations";',
        'import { z } from "zod";',
        "const input = noInput;",
        "export default defineOperation({",
        '  kind: "query",',
        "  input,",
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(checkProject(localAliasRoot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BBK210" })]),
    );

    const wrapperRoot = temporaryProject();
    addOperation(wrapperRoot, "reports.get", "query");
    writeFileSync(
      join(wrapperRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import { noInput } from "@bb-kit/core/operations";',
        'import { z } from "zod";',
        "function wrap(value: unknown) { return value; }",
        "export default wrap({",
        '  kind: "query",',
        "  input: noInput,",
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(checkProject(wrapperRoot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BBK210" })]),
    );

    const structuralNullRoot = temporaryProject();
    addOperation(structuralNullRoot, "reports.get", "query");
    writeFileSync(
      join(structuralNullRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import { defineOperation } from "@bb-kit/core/operations";',
        'import { z } from "zod";',
        "export default defineOperation({",
        '  kind: "query",',
        "  input: z.null(),",
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(checkProject(structuralNullRoot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BBK210" })]),
    );
  });

  it("reads literal required examples and rejects dynamic metadata", () => {
    const literalRoot = temporaryProject();
    addOperation(literalRoot, "reports.get", "query");
    writeFileSync(
      join(literalRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import { defineOperation } from "@bb-kit/core/operations";',
        'import { z } from "zod";',
        "export default defineOperation({",
        '  kind: "query",',
        "  input: z.null(),",
        '  exampleInput: (({ id: "A-1", nested: [true, null, -2] } as const) satisfies object),',
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(inspectProject(literalRoot).modules[0]?.operations[0]).toEqual(
      expect.objectContaining({
        input: {
          mode: "required",
          example: { id: "A-1", nested: [true, null, -2] },
        },
        metadataError: null,
      }),
    );

    const dynamicRoot = temporaryProject();
    addOperation(dynamicRoot, "reports.get", "query");
    writeFileSync(
      join(dynamicRoot, "plugin/modules/reports/operations/get.ts"),
      [
        'import { defineOperation } from "@bb-kit/core/operations";',
        'import { z } from "zod";',
        'const example = { id: "A-1" };',
        "export default defineOperation({",
        '  kind: "query",',
        "  input: z.object({ id: z.string() }),",
        "  exampleInput: example,",
        "  output: z.null(),",
        "});",
        "",
      ].join("\n"),
    );
    expect(checkProject(dynamicRoot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BBK210" })]),
    );
  });

  it("rejects frontend imports of server adapters", () => {
    const root = temporaryProject();
    addModule(root, "reports");
    writeFileSync(
      join(root, "plugin/modules/reports/panel.tsx"),
      'import "./repository.js";\nexport function Panel() { return null; }\n',
    );
    expect(checkProject(root)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BBK104" })]),
    );
  });

  it("rejects cross-module internals and import cycles", () => {
    const root = temporaryProject();
    addModule(root, "reports");
    addModule(root, "approvals");
    writeFileSync(
      join(root, "plugin/modules/reports/internal.ts"),
      'import "../approvals/service.js";\nexport const reports = true;\n',
    );
    writeFileSync(
      join(root, "plugin/modules/reports/first.ts"),
      'import "./second.js";\nexport const first = true;\n',
    );
    writeFileSync(
      join(root, "plugin/modules/reports/second.ts"),
      'import "./first.js";\nexport const second = true;\n',
    );
    expect(checkProject(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BBK106" }),
        expect.objectContaining({ code: "BBK107" }),
      ]),
    );
  });

  it("rejects module-scope resources and undeclared runtime packages", () => {
    const root = temporaryProject();
    addModule(root, "reports");
    writeFileSync(
      join(root, "plugin/modules/reports/repository.ts"),
      'import ky from "ky";\nexport const timer = setInterval(() => ky.get("/"), 1000);\n',
    );
    expect(checkProject(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BBK108" }),
        expect.objectContaining({ code: "BBK109" }),
      ]),
    );
  });

  it("locks append-only migrations and detects edits", () => {
    const root = temporaryProject();
    expect(addMigration(root, "reports", "initial")).toEqual([
      "plugin/modules/reports/migrations/001-initial.sql",
    ]);
    expect(addMigration(root, "reports", "initial")).toEqual([]);
    expect(addMigration(root, "reports", "add-revision")).toEqual([
      "plugin/modules/reports/migrations/002-add-revision.sql",
    ]);
    expect(checkProject(root)).toEqual([]);

    writeFileSync(join(root, "plugin/modules/reports/migrations/001-initial.sql"), "select 1;\n");
    expect(checkProject(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BBK304" }),
        expect.objectContaining({ code: "BBK305" }),
      ]),
    );
    expect(() => addMigration(root, "reports", "initial")).toThrow(/was modified/);
  });

  it("refuses unknown composition roots before creating a module", () => {
    const root = temporaryProject();
    writeFileSync(join(root, "plugin/server.ts"), "export default { setup() {} };\n");
    expect(() => addModule(root, "reports")).toThrow(/composition root/);
    expect(existsSync(join(root, "plugin/modules/reports"))).toBe(false);
  });

  it("refuses unknown app roots before creating panel files", () => {
    const root = temporaryProject();
    writeFileSync(join(root, "plugin/app.tsx"), "export default {};\n");
    expect(() => addPanel(root, "reports", "nav")).toThrow(/composition root/);
    expect(existsSync(join(root, "plugin/modules/reports"))).toBe(false);
  });

  it("returns a stable diagnostic for malformed manifests", () => {
    const root = temporaryProject();
    writeFileSync(join(root, "package.json"), "{ definitely not json\n");
    expect(checkProject(root)).toEqual([
      expect.objectContaining({ code: "BBK000", severity: "error" }),
    ]);
  });

  it("generates a plugin slice that typechecks", () => {
    const root = temporaryProject();
    addOperation(root, "approvals.get", "query");
    addMigration(root, "approvals", "initial");
    expect(addPanel(root, "approvals", "thread")).toEqual([
      "plugin/modules/approvals/panel.tsx",
      "plugin/modules/approvals/app.tsx",
    ]);
    expect(addPanel(root, "approvals", "thread")).toEqual([]);
    expect(readFileSync(join(root, "plugin/modules/approvals/server.ts"), "utf8")).toContain(
      "bb.storage.migrate(approvalsDatabase, approvalsMigrations)",
    );
    expect(readFileSync(join(root, "plugin/app.tsx"), "utf8")).toContain(
      "registerApprovalsApp(app)",
    );
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@tanstack/react-query"]).toBe("^5.101.4");
    expect(checkProject(root)).toEqual([]);
    expect(inspectProject(root).modules[0]).toEqual(
      expect.objectContaining({
        surfaces: ["thread-panel"],
        storage: "sqlite",
      }),
    );
    const tsconfigPath = join(root, "tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
      compilerOptions: { paths: Record<string, string[]>; typeRoots?: string[] };
    };
    tsconfig.compilerOptions.typeRoots = [join(repositoryRoot, "node_modules/@types")];
    tsconfig.compilerOptions.paths["@get-bb/plugin-sdk"] = [
      join(repositoryRoot, "node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts"),
    ];
    tsconfig.compilerOptions.paths["@get-bb/plugin-sdk/app"] = [
      join(repositoryRoot, "node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts"),
    ];
    tsconfig.compilerOptions.paths["@bb-kit/core/operations"] = [
      join(repositoryRoot, "packages/bb-kit/src/operations.ts"),
    ];
    tsconfig.compilerOptions.paths["@bb-kit/core/query"] = [
      join(repositoryRoot, "packages/bb-kit/src/query.ts"),
    ];
    tsconfig.compilerOptions.paths.zod = [join(repositoryRoot, "node_modules/zod/index.d.cts")];
    tsconfig.compilerOptions.paths.react = [
      join(repositoryRoot, "node_modules/@types/react/index.d.ts"),
    ];
    tsconfig.compilerOptions.paths["better-sqlite3"] = [
      join(repositoryRoot, "node_modules/@types/better-sqlite3/index.d.ts"),
    ];
    tsconfig.compilerOptions.paths.hono = [
      join(repositoryRoot, "node_modules/hono/dist/types/index.d.ts"),
    ];
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

    const result = spawnSync(
      "bun",
      [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", tsconfigPath],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.stderr || result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("preserves explicit wire locks and refuses derived collisions", () => {
    const root = temporaryProject();
    const lock = readLock(root);
    lock.operations["approvals.get"] = { rpcMethod: "legacy_approval_get" };
    writeFileSync(join(root, "bb-kit.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    addOperation(root, "approvals.get", "query");
    expect(
      readFileSync(join(root, "plugin/modules/approvals/generated/operations.ts"), "utf8"),
    ).toContain('wireMethod: "legacy_approval_get"');

    addOperation(root, "foo-bar.get", "query");
    expect(() => addOperation(root, "foo.bar-get", "query")).toThrow(/collides/);
    expect(existsSync(join(root, "plugin/modules/foo"))).toBe(false);
  });
});
