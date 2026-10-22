import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import plugin from "../server.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-playbooks-"));
  const directory = join(root, ".agents", "review");
  mkdirSync(directory, { recursive: true });
  const f = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      threads: { get: async () => makeThreadResponse({ environmentId: "checkout" }) },
      environments: { get: async () => ({ hostId: "remote", path: root }) },
      files: {
        list: async ({ hostId, path }) => {
          assert.equal(hostId, "remote");
          assert.equal(path, directory);
          return {
            files: [
              { path: "correctness.md", name: "correctness.md" },
              { path: "networking.md", name: "networking.md" },
            ],
            truncated: false,
          };
        },
        read: async ({ hostId, path, rootPath }) => {
          assert.equal(hostId, "remote");
          assert.equal(rootPath, directory);
          const content = readFileSync(path, "utf8");
          return {
            path,
            content,
            contentEncoding: "utf8",
            sha256: "fixture",
            sizeBytes: Buffer.byteLength(content),
          };
        },
      },
    },
  });
  writeFileSync(
    join(directory, "correctness.md"),
    '---\ndescription: "Project correctness checks."\n---\n# Local checks\n',
  );
  writeFileSync(
    join(directory, "networking.md"),
    "---\r\ndescription: >-\r\n  Changes to transport\r\n  and reconnect behavior.\r\n---\r\n# Networking\r\n",
  );
  await plugin(f.bb);
  return {
    ...f,
    root,
    directory,
    async dispose() {
      await f.harness.lifecycle.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("review lists both scopes using YAML descriptions on the thread's machine", async () => {
  const f = await fixture();
  try {
    assert.equal(f.harness.inspection.registrations.cli?.name, "review");
    const result = await f.harness.behavior.runCli(["playbook"], {
      threadId: "reviewer",
      cwd: "/wrong/server/checkout",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /global\/correctness — State, concurrency/);
    assert.match(result.stdout, /project\/correctness — Project correctness checks/);
    assert.match(
      result.stdout,
      /project\/networking — Changes to transport and reconnect behavior/,
    );
    assert.doesNotMatch(result.stdout, /# Networking/);
  } finally {
    await f.dispose();
  }
});

test("reading a global playbook needs no project host or directory", async () => {
  const f = await fixture();
  try {
    const result = await f.harness.behavior.runCli(["playbook", "--name", "global/security"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /# Security/);
    assert.equal(f.harness.inspection.sdk.callsTo("files.read").length, 0);
    assert.equal(f.harness.inspection.sdk.callsTo("threads.get").length, 0);
  } finally {
    await f.dispose();
  }
});

test("reading one project playbook returns only that file", async () => {
  const f = await fixture();
  try {
    const result = await f.harness.behavior.runCli(
      ["playbook", "--name", "project/networking", "--json"],
      { threadId: "reviewer" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.id, "project/networking");
    assert.equal(parsed.description, "Changes to transport and reconnect behavior.");
    assert.match(parsed.content, /# Networking/);
    assert.equal(f.harness.inspection.sdk.callsTo("files.read").length, 1);
  } finally {
    await f.dispose();
  }
});

test("outside a thread project reads require an explicit machine and absolute directory", async () => {
  const f = await fixture();
  try {
    const globals = await f.harness.behavior.runCli(["playbook", "--json"], { cwd: f.root });
    assert.equal(globals.exitCode, 0);
    assert.equal(JSON.parse(globals.stdout).playbooks.length, 6);
    assert.match(JSON.parse(globals.stdout).warnings[0], /--machine/);
    assert.equal(f.harness.inspection.sdk.callsTo("files.list").length, 0);
    const explicit = await f.harness.behavior.runCli([
      "playbook",
      "--machine",
      "remote",
      "--directory",
      f.root,
    ]);
    assert.equal(explicit.exitCode, 0, explicit.stderr);
    assert.match(explicit.stdout, /project\/networking/);
    const relative = await f.harness.behavior.runCli([
      "playbook",
      "--machine",
      "remote",
      "--directory",
      ".",
    ]);
    assert.equal(relative.exitCode, 1);
    const missing = await f.harness.behavior.runCli(["playbook", "--machine", "remote"]);
    assert.equal(missing.exitCode, 1);
  } finally {
    await f.dispose();
  }
});

test("only ENOENT makes a missing project folder empty; truncation and offline errors surface", async () => {
  const f = await fixture();
  try {
    f.harness.sdk.stub("files.list", async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const absent = await f.harness.behavior.runCli(["playbook", "--json"], {
      threadId: "reviewer",
    });
    assert.equal(absent.exitCode, 0);
    assert.equal(JSON.parse(absent.stdout).playbooks.length, 6);
    f.harness.sdk.stub("files.list", async () => ({ files: [], truncated: false }));
    const empty = await f.harness.behavior.runCli(["playbook", "--json"], { threadId: "reviewer" });
    assert.equal(JSON.parse(empty.stdout).playbooks.length, 6);
    assert.deepEqual(JSON.parse(empty.stdout).warnings, []);
    f.harness.sdk.stub("files.list", async () => ({ files: [], truncated: true }));
    const truncated = await f.harness.behavior.runCli(["playbook"], { threadId: "reviewer" });
    assert.equal(truncated.exitCode, 0);
    assert.match(truncated.stdout, /global\/correctness/);
    assert.match(truncated.stderr, /exceeds 256/);
    f.harness.sdk.stub("files.list", async () => {
      throw new Error("host offline");
    });
    const offline = await f.harness.behavior.runCli(["playbook"], { threadId: "reviewer" });
    assert.equal(offline.exitCode, 0);
    assert.match(offline.stdout, /global\/security/);
    assert.match(offline.stderr, /host offline/);
  } finally {
    await f.dispose();
  }
});

test("nested playbooks on Windows keep the selected host's path semantics", async () => {
  const f = await fixture();
  try {
    f.harness.sdk.stub("environments.get", async () => ({ hostId: "windows", path: "C:\\Game" }));
    f.harness.sdk.stub("files.list", async ({ hostId, path }) => {
      assert.equal(hostId, "windows");
      assert.equal(path, "C:\\Game\\.agents\\review");
      return { files: [{ name: "transport.md", path: "network\\transport.md" }], truncated: false };
    });
    f.harness.sdk.stub("files.read", async ({ hostId, path, rootPath }) => {
      assert.equal(hostId, "windows");
      assert.equal(rootPath, "C:\\Game\\.agents\\review");
      assert.equal(path, "C:\\Game\\.agents\\review\\network\\transport.md");
      return {
        path,
        content: "---\ndescription: Transport changes.\n---\n# Transport\n",
        contentEncoding: "utf8",
        sha256: "fixture",
        sizeBytes: 58,
      };
    });
    const result = await f.harness.behavior.runCli(
      ["playbook", "--name", "project/network/transport"],
      { threadId: "reviewer" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /# Transport/);
  } finally {
    await f.dispose();
  }
});

test("unsafe listed paths and non-text playbooks are rejected", async () => {
  const f = await fixture();
  try {
    f.harness.sdk.stub("files.list", async () => ({
      files: [{ name: "secret.md", path: "../secret.md" }],
      truncated: false,
    }));
    const unsafe = await f.harness.behavior.runCli(["playbook"], { threadId: "reviewer" });
    assert.equal(unsafe.exitCode, 0);
    assert.match(unsafe.stderr, /Invalid project playbook path/);
    f.harness.sdk.stub("files.list", async () => ({
      files: [{ name: "binary.md", path: "binary.md" }],
      truncated: false,
    }));
    f.harness.sdk.stub("files.read", async () => ({
      path: "binary.md",
      content: "AAAA",
      contentEncoding: "base64",
      sha256: "fixture",
      sizeBytes: 3,
    }));
    const binary = await f.harness.behavior.runCli(["playbook", "--name", "project/binary"], {
      threadId: "reviewer",
    });
    assert.equal(binary.exitCode, 1);
    assert.match(binary.stderr, /UTF-8 Markdown/);
  } finally {
    await f.dispose();
  }
});

test("large indexes shrink to the byte budget and paginate without losing entries", async () => {
  const f = await fixture();
  try {
    const files = Array.from({ length: 256 }, (_, index) => ({
      name: `${index}.md`,
      path: "nested/".repeat(190) + `${index.toString().padStart(3, "0")}.md`,
    }));
    f.harness.sdk.stub("files.list", async () => ({ files, truncated: false }));
    f.harness.sdk.stub("files.read", async ({ path }) => ({
      path,
      content: `---\ndescription: ${"界".repeat(1000)}\n---\n# Large\n`,
      contentEncoding: "utf8",
      sha256: "fixture",
      sizeBytes: 3030,
    }));
    const ids: string[] = [];
    let offset = 0;
    let pages = 0;
    while (true) {
      const result = await f.harness.behavior.runCli(
        ["playbook", "--json", "--offset", String(offset), "--limit", "256"],
        { threadId: "reviewer" },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
          PLUGIN_CLI_OUTPUT_MAX_BYTES,
      );
      const page = JSON.parse(result.stdout);
      ids.push(...page.playbooks.map((entry: { id: string }) => entry.id));
      pages++;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.ok(pages > 1);
    assert.equal(ids.length, 262);
    assert.equal(new Set(ids).size, 262);
  } finally {
    await f.dispose();
  }
});

test("invalid metadata is diagnosed and unknown names cannot read arbitrary paths", async () => {
  const f = await fixture();
  try {
    writeFileSync(
      join(f.directory, "correctness.md"),
      "---\ndescription: [not, text]\n---\n# Invalid\n",
    );
    const listed = await f.harness.behavior.runCli(["playbook", "--json"], {
      threadId: "reviewer",
    });
    assert.equal(listed.exitCode, 0);
    assert.match(JSON.parse(listed.stdout).warnings[0], /project\/correctness/);
    for (const name of ["../../package.json", "global/../security", "project/../../secret"]) {
      const result = await f.harness.behavior.runCli(["playbook", "--name", name], {
        threadId: "reviewer",
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Unknown review playbook/);
    }
  } finally {
    await f.dispose();
  }
});
