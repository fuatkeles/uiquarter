import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { compareBranches } from "../../src/drift/BranchDiff.js";
import type { BranchDiffOptions } from "../../src/drift/BranchDiff.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

async function testNonGitRepoThrows(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-bd-"));
  try {
    await assert.rejects(
      () => compareBranches({ rootPath: tmp, targetBranch: "main", format: "text" }),
      (err: Error) => {
        assert.ok(err.message.includes("Not a git repository"));
        return true;
      },
    );
    ok("testNonGitRepoThrows");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testInvalidBranchThrows(): Promise<void> {
  // Use the project root (which is a git repo... or not)
  // We create a temp git repo for this test
  const { execSync } = await import("node:child_process");
  const { writeFile, mkdir } = await import("node:fs/promises");

  const tmp = await mkdtemp(join(tmpdir(), "uiq-bd-git-"));
  try {
    execSync("git init", { cwd: tmp, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: tmp, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: tmp, stdio: "ignore" });
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src", "index.ts"), "export const x = 1;");
    execSync("git add -A && git commit -m initial", { cwd: tmp, stdio: "ignore" });

    await assert.rejects(
      () =>
        compareBranches({
          rootPath: tmp,
          targetBranch: "nonexistent-branch-xyz",
          format: "text",
        }),
      (err: Error) => {
        assert.ok(err.message.includes("not found"));
        return true;
      },
    );
    ok("testInvalidBranchThrows");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testOptionsInterface(): Promise<void> {
  // Just verify the types are correct
  const opts: BranchDiffOptions = {
    rootPath: "/tmp/test",
    targetBranch: "main",
    format: "text",
  };
  assert.equal(opts.rootPath, "/tmp/test");
  assert.equal(opts.targetBranch, "main");
  assert.equal(opts.format, "text");

  const mdOpts: BranchDiffOptions = { ...opts, format: "md" };
  assert.equal(mdOpts.format, "md");

  const jsonOpts: BranchDiffOptions = { ...opts, format: "json" };
  assert.equal(jsonOpts.format, "json");

  ok("testOptionsInterface");
}

async function testExportsExist(): Promise<void> {
  // Verify the module exports are correct
  assert.equal(typeof compareBranches, "function");
  ok("testExportsExist");
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("BranchDiff Tests");

  await testExportsExist();
  await testOptionsInterface();
  await testNonGitRepoThrows();
  await testInvalidBranchThrows();

  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
