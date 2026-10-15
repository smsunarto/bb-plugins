import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeBut } from "../../test/fake-but.ts";
import {
  ButFailedError,
  ButMissingError,
  ButSetupRequiredError,
  runBut,
  runButAction,
  runGit,
  runGitCommand,
} from "./cli.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const missingDirectory = join(here, "no-such-directory-for-this-test");
const signal = new AbortController().signal;

test("a missing working directory is reported as a missing repository", async () => {
  // Node raises the same ENOENT for a missing program and a missing cwd, so a
  // repository that moved must not read as "the CLI is not installed".
  const failure = await runGit(missingDirectory, ["status"], signal).catch((error) => error);
  expect(failure).toBeInstanceOf(ButFailedError);
  expect(failure).not.toBeInstanceOf(ButMissingError);
  expect((failure as Error).message).toBe("The repository directory is no longer available.");
});

test("but in a missing working directory is not reported as an uninstalled CLI", async () => {
  const failure = await runBut(missingDirectory, ["status"], signal).catch((error) => error);
  expect(failure).toBeInstanceOf(ButFailedError);
  expect(failure).not.toBeInstanceOf(ButMissingError);
  expect((failure as Error).message).toBe("The repository directory is no longer available.");
});

test("git failures surface the command's own message", async () => {
  const failure = await runGit(here, ["cat-file", "-p", "notacommit"], signal).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(ButFailedError);
  expect((failure as Error).message).toContain("notacommit");
});

test("git output past the buffer reads as a diff too large to show", async () => {
  // An alias stands in for `git show` on a commit of 34 MB.
  const args = ["-c", "alias.huge=!head -c 34000000 /dev/zero", "huge"];
  const failure = await runGit(here, args, signal).catch((error) => error);
  expect(failure).toBeInstanceOf(ButFailedError);
  expect((failure as Error).message).toBe("This diff is too large to show.");
});

test("a refused action reads as what failed and why, without the CLI's hint", async () => {
  const restore = await fakeBut(
    "printf 'Error: Branch not found\\nCaused by:\\n  no ref\\nHint: run but status\\n' >&2; exit 1",
  );
  try {
    const failure = await runButAction(here, ["push", "x"], signal).catch((error) => error);
    expect(failure).toBeInstanceOf(ButFailedError);
    expect((failure as Error).message).toBe("Branch not found no ref");
  } finally {
    await restore();
  }
});

test("a repository GitButler has not set up is told apart from other refusals", async () => {
  const restore = await fakeBut(
    `echo '{"error":"setup_required","message":"No GitButler project found at ."}'; exit 1`,
  );
  try {
    const failure = await runBut(here, ["status"], signal).catch((error) => error);
    expect(failure).toBeInstanceOf(ButSetupRequiredError);
    expect((failure as Error).message).toBe("No GitButler project found at .");
  } finally {
    await restore();
  }
});

async function sshFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gitbutler-ssh-"));
  const repository = join(directory, "repo");
  const wrapper = join(directory, "ssh-wrapper");
  const log = join(directory, "ssh.log");
  const globalConfig = join(directory, "global.gitconfig");
  const env = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH_COMMAND: undefined,
    GIT_SSH: undefined,
    GIT_SSH_VARIANT: "ssh",
    SSH_TEST_LOG: log,
  };
  await mkdir(repository);
  await writeFile(globalConfig, "");
  await writeFile(
    wrapper,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$SSH_TEST_LOG"\nprintf "configured SSH reached\\n" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  await runGit(repository, ["init", "--quiet"], signal, undefined, env);
  await runGit(
    repository,
    ["remote", "add", "origin", "ssh://git@example.invalid/repository.git"],
    signal,
    undefined,
    env,
  );
  return { directory, repository, wrapper, log, globalConfig, env };
}

for (const configuration of ["repository", "global", "command", "environment", "plink"] as const) {
  test(`native Git honors ${configuration} SSH configuration`, async () => {
    const fixture = await sshFixture();
    try {
      const { repository, wrapper, globalConfig, env, log } = fixture;
      let args = ["ls-remote", "--", "origin"];
      let commandEnv: NodeJS.ProcessEnv = env;
      if (configuration === "repository" || configuration === "global") {
        await runGit(
          repository,
          [
            "config",
            ...(configuration === "global" ? ["--file", globalConfig] : []),
            "core.sshCommand",
            `'${wrapper}' configured-key`,
          ],
          signal,
          undefined,
          env,
        );
      } else if (configuration === "command") {
        args = ["-c", `core.sshCommand='${wrapper}' configured-key`, ...args];
      } else if (configuration === "environment") {
        await runGit(repository, ["config", "core.sshCommand", "unavailable-ssh"], signal);
        commandEnv = { ...env, GIT_SSH_COMMAND: `'${wrapper}' configured-key` };
      } else {
        commandEnv = { ...env, GIT_SSH: wrapper, GIT_SSH_VARIANT: "plink" };
      }
      const result = await runGitCommand(repository, args, signal, undefined, commandEnv);
      expect(result.code).toBe(128);
      expect(result.stderr).toContain("configured SSH reached");
      const invoked = await readFile(log, "utf8");
      expect(invoked).toContain("git@example.invalid");
      expect(invoked).not.toContain("BatchMode");
      if (configuration !== "plink") expect(invoked.split("\n")[0]).toBe("configured-key");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("stock SSH receives BatchMode without replacing configured transports", async () => {
  const fixture = await sshFixture();
  try {
    const { directory, repository, wrapper, log, env } = fixture;
    await writeFile(join(directory, "ssh"), await readFile(wrapper), { mode: 0o755 });
    const result = await runGitCommand(
      repository,
      ["ls-remote", "--", "origin"],
      signal,
      undefined,
      {
        ...env,
        PATH: `${directory}${delimiter}${process.env["PATH"] ?? ""}`,
      },
    );
    expect(result.code).toBe(128);
    expect(result.stderr).toContain("configured SSH reached");
    expect((await readFile(log, "utf8")).split("\n")[0]).toBe("-oBatchMode=yes");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
