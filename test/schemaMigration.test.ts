import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  CURRENT_SCHEMA_VERSION,
  checkSchemaVersion,
  migrateSchema,
} from "../src/core/schemaMigration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function pass(name: string): void {
  console.log(`  PASS: ${name}`);
  passed++;
}

function makeTestDir(): string {
  return join(
    tmpdir(),
    "uiq-schema-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
  );
}

async function createProjectWithIndex(): Promise<string> {
  const root = makeTestDir();
  const srcDir = join(root, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, "App.tsx"), `export default function App() { return <div/>; }\n`);
  execSync("node dist/cli.js init -d " + JSON.stringify(root), {
    cwd: join(__dirname, ".."),
    stdio: "pipe",
  });
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testCurrentSchemaVersion() {
  assert(typeof CURRENT_SCHEMA_VERSION === "number", "Should be a number");
  assert(CURRENT_SCHEMA_VERSION >= 1, "Should be >= 1");
  pass("testCurrentSchemaVersion");
}

async function testCheckMissingUiq() {
  const root = makeTestDir();
  await mkdir(root, { recursive: true });
  try {
    const result = await checkSchemaVersion(root);
    assert(result.status === "missing", "Should be missing");
    assert(result.diskVersion === null, "No disk version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testCheckMissingUiq");
}

async function testCheckCurrentVersion() {
  const root = await createProjectWithIndex();
  try {
    const result = await checkSchemaVersion(root);
    assert(result.status === "current", `Should be current, got ${result.status}: ${result.message}`);
    assert(result.diskVersion === CURRENT_SCHEMA_VERSION, "Disk version should match current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testCheckCurrentVersion");
}

async function testCheckCorruptMeta() {
  const root = makeTestDir();
  const uiqDir = join(root, ".uiq");
  await mkdir(uiqDir, { recursive: true });
  await writeFile(join(uiqDir, "meta.json"), "not json", "utf-8");
  try {
    const result = await checkSchemaVersion(root);
    assert(result.status === "corrupt", "Should be corrupt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testCheckCorruptMeta");
}

async function testCheckMissingSchemaField() {
  const root = makeTestDir();
  const uiqDir = join(root, ".uiq");
  await mkdir(uiqDir, { recursive: true });
  await writeFile(join(uiqDir, "meta.json"), JSON.stringify({ toolVersion: "0.1.0" }), "utf-8");
  try {
    const result = await checkSchemaVersion(root);
    assert(result.status === "corrupt", "Should be corrupt for missing field");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testCheckMissingSchemaField");
}

async function testCheckNewerThanTool() {
  const root = makeTestDir();
  const uiqDir = join(root, ".uiq");
  await mkdir(uiqDir, { recursive: true });
  await writeFile(
    join(uiqDir, "meta.json"),
    JSON.stringify({ schemaVersion: 999 }),
    "utf-8",
  );
  try {
    const result = await checkSchemaVersion(root);
    assert(result.status === "newer-than-tool", "Should detect newer version");
    assert(result.diskVersion === 999, "Disk version should be 999");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testCheckNewerThanTool");
}

async function testMigrateCurrentDoesNothing() {
  const root = await createProjectWithIndex();
  try {
    const applied = await migrateSchema(root);
    assert(applied === 0, "Should apply 0 migrations for current schema");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testMigrateCurrentDoesNothing");
}

async function testMigrateMissingThrows() {
  const root = makeTestDir();
  await mkdir(root, { recursive: true });
  try {
    await migrateSchema(root);
    assert(false, "Should throw for missing .uiq");
  } catch (err) {
    assert(err instanceof Error, "Should throw Error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testMigrateMissingThrows");
}

async function testMigrateNewerThrows() {
  const root = makeTestDir();
  const uiqDir = join(root, ".uiq");
  await mkdir(uiqDir, { recursive: true });
  await writeFile(join(uiqDir, "meta.json"), JSON.stringify({ schemaVersion: 999 }), "utf-8");
  try {
    await migrateSchema(root);
    assert(false, "Should throw for newer schema");
  } catch (err) {
    assert(err instanceof Error, "Should throw Error");
    assert((err as Error).message.includes("newer"), "Should mention newer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testMigrateNewerThrows");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Schema Migration tests\n");

  testCurrentSchemaVersion();
  await testCheckMissingUiq();
  await testCheckCurrentVersion();
  await testCheckCorruptMeta();
  await testCheckMissingSchemaField();
  await testCheckNewerThanTool();
  await testMigrateCurrentDoesNothing();
  await testMigrateMissingThrows();
  await testMigrateNewerThrows();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
