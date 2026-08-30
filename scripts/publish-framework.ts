#!/usr/bin/env bun
/** Build, inspect, and publish framework packages under packages/. */
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { packageProblems, packedPaths, probeNpmVersion, publishPackageVersion } from "./publish";
import {
  publishableWorkspacePackages,
  selectWorkspacePackages,
  type WorkspacePackage,
} from "./workspace-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function runInteractive(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

interface PublishPlan {
  candidate: WorkspacePackage;
  version: string;
  paths: string[];
}

function buildPublishPlans(targets: readonly WorkspacePackage[]): PublishPlan[] {
  run(
    "bun",
    ["run", ...targets.flatMap((candidate) => ["--filter", candidate.name]), "--parallel", "build"],
    ROOT,
  );

  return targets.map((candidate) => {
    const version = candidate.manifest.version;
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error(`${candidate.directory}: package.json has no version`);
    }
    const paths = packedPaths(run("bun", ["pm", "pack", "--dry-run"], candidate.dir));
    const problems = packageProblems(candidate.manifest, paths);
    if (problems.length > 0) {
      throw new Error(
        `${candidate.directory} cannot be published:\n${problems
          .map((problem) => `    - ${problem}`)
          .join("\n")}`,
      );
    }
    return { candidate, version, paths };
  });
}

async function publishPlans(plans: readonly PublishPlan[], dryRun: boolean): Promise<void> {
  for (const { candidate, version, paths } of plans) {
    const packageVersion = `${candidate.name}@${version}`;
    if (dryRun) {
      const state = probeNpmVersion(candidate.name, version);
      console.log(
        state.kind === "published"
          ? `  ${packageVersion} already published — skipping`
          : `  ${packageVersion} ready (${paths.length} files)`,
      );
      continue;
    }

    const result = await publishPackageVersion({
      packageVersion,
      probe: () => probeNpmVersion(candidate.name, version),
      publish: () => {
        console.log(`  publishing ${packageVersion}…`);
        runInteractive("npm", ["publish", "--access", "public"], candidate.dir);
      },
      sleep: wait,
    });
    switch (result.kind) {
      case "already-published":
        console.log(`  ${packageVersion} already published — skipping`);
        break;
      case "published":
        console.log(`  ✓ ${packageVersion}`);
        break;
      case "reconciled":
        console.log(`  ✓ ${packageVersion} was already accepted — registry caught up`);
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(`unhandled publish result: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const requestedDirectories: string[] = [];
  const unknown: string[] = [];
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--package") {
      const directory = args[index + 1];
      if (directory === undefined || directory.startsWith("--")) {
        unknown.push("--package requires a directory");
      } else {
        requestedDirectories.push(directory);
        index += 1;
      }
      continue;
    }
    if (argument !== undefined) unknown.push(argument);
  }
  if (unknown.length > 0) {
    throw new Error(
      `publish-framework: unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }

  const targets = selectWorkspacePackages(publishableWorkspacePackages(ROOT), requestedDirectories);
  console.log(`publishing ${targets.length} framework package${targets.length === 1 ? "" : "s"}\n`);
  await publishPlans(buildPublishPlans(targets), dryRun);
}

if (import.meta.main) await main();
