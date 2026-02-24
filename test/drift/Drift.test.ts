import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  loadSnapshot,
  computeDrift,
  formatDriftText,
  formatDriftMarkdown,
  formatDriftJson,
} from "../../src/drift/DriftDetector.js";
import type { DriftSnapshot, DriftReport } from "../../src/drift/DriftDetector.js";
import { runDriftCommand } from "../../src/cli/drift.js";

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
    "uiq-drift-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
  );
}

async function createProjectWithIndex(): Promise<string> {
  const root = makeTestDir();
  const srcDir = join(root, "src");
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(srcDir, "App.tsx"),
    `import { Button } from "./Button";\nexport default function App() { return <Button />; }\n`,
  );
  await writeFile(
    join(srcDir, "Button.tsx"),
    `export function Button() { return <button>Click</button>; }\n`,
  );

  execSync("node dist/cli.js init -d " + JSON.stringify(root), {
    cwd: join(__dirname, "..", ".."),
    stdio: "pipe",
  });

  return root;
}

function makeMockSnapshot(overrides?: Partial<DriftSnapshot>): DriftSnapshot {
  return {
    meta: {
      intelligenceHash: "abc123",
      generatedAt: "2026-01-01T00:00:00.000Z",
      toolVersion: "0.1.0",
      schemaVersion: 1,
      buildNumber: 1,
      compositeHash: "def456",
      stats: {
        totalPatterns: 10,
        totalEdges: 5,
        totalFiles: 3,
        byFramework: { react: 8, unknown: 2 },
        byType: { component: 6, hook: 2, utility: 2 },
      },
    },
    patternIds: ["src/App.tsx:App:1", "src/Button.tsx:Button:1"],
    insightIds: ["hub-1", "orphan-1"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: computeDrift
// ---------------------------------------------------------------------------

function testNoDrift() {
  const before = makeMockSnapshot();
  const after = makeMockSnapshot();
  const report = computeDrift(before, after);
  assert(report.hashChanged === false, "Hash should not change");
  assert(report.patterns.added.length === 0, "No patterns added");
  assert(report.patterns.removed.length === 0, "No patterns removed");
  assert(report.insights.added.length === 0, "No insights added");
  assert(report.insights.removed.length === 0, "No insights removed");
  assert(report.stats.patternDelta === 0, "Pattern delta 0");
  pass("testNoDrift");
}

function testHashChanged() {
  const before = makeMockSnapshot();
  const after = makeMockSnapshot({
    meta: { ...before.meta, intelligenceHash: "xyz789", buildNumber: 2 },
  });
  const report = computeDrift(before, after);
  assert(report.hashChanged === true, "Hash should change");
  assert(report.buildBefore === 1, "Build before = 1");
  assert(report.buildAfter === 2, "Build after = 2");
  pass("testHashChanged");
}

function testPatternsAdded() {
  const before = makeMockSnapshot();
  const after = makeMockSnapshot({
    patternIds: [...before.patternIds, "src/Modal.tsx:Modal:1"],
  });
  const report = computeDrift(before, after);
  assert(report.patterns.added.length === 1, "1 pattern added");
  assert(report.patterns.added[0] === "src/Modal.tsx:Modal:1", "Correct pattern added");
  assert(report.patterns.removed.length === 0, "No patterns removed");
  pass("testPatternsAdded");
}

function testPatternsRemoved() {
  const before = makeMockSnapshot();
  const after = makeMockSnapshot({
    patternIds: ["src/App.tsx:App:1"],
  });
  const report = computeDrift(before, after);
  assert(report.patterns.removed.length === 1, "1 pattern removed");
  assert(report.patterns.removed[0] === "src/Button.tsx:Button:1", "Correct pattern removed");
  pass("testPatternsRemoved");
}

function testInsightsChanged() {
  const before = makeMockSnapshot();
  const after = makeMockSnapshot({
    insightIds: ["hub-1", "cycle-1"],
  });
  const report = computeDrift(before, after);
  assert(report.insights.added.length === 1, "1 insight added");
  assert(report.insights.added[0] === "cycle-1", "cycle-1 added");
  assert(report.insights.removed.length === 1, "1 insight removed");
  assert(report.insights.removed[0] === "orphan-1", "orphan-1 removed");
  pass("testInsightsChanged");
}

function testStatsDelta() {
  const before = makeMockSnapshot();
  const after = makeMockSnapshot({
    meta: {
      ...before.meta,
      stats: { ...before.meta.stats, totalPatterns: 15, totalEdges: 8, totalFiles: 5 },
    },
  });
  const report = computeDrift(before, after);
  assert(report.stats.patternDelta === 5, "Pattern delta = +5");
  assert(report.stats.edgeDelta === 3, "Edge delta = +3");
  assert(report.stats.fileDelta === 2, "File delta = +2");
  pass("testStatsDelta");
}

// ---------------------------------------------------------------------------
// Unit tests: formatters
// ---------------------------------------------------------------------------

function testFormatText() {
  const report = computeDrift(
    makeMockSnapshot(),
    makeMockSnapshot({
      meta: { ...makeMockSnapshot().meta, intelligenceHash: "new", buildNumber: 2 },
      patternIds: [...makeMockSnapshot().patternIds, "src/Modal.tsx:Modal:1"],
    }),
  );
  const text = formatDriftText(report);
  assert(text.includes("Context Drift Report"), "Should have title");
  assert(text.includes("#1"), "Should show build 1");
  assert(text.includes("#2"), "Should show build 2");
  assert(text.includes("YES"), "Should show hash changed");
  assert(text.includes("[+] src/Modal.tsx:Modal:1"), "Should show added pattern");
  pass("testFormatText");
}

function testFormatMarkdown() {
  const report = computeDrift(makeMockSnapshot(), makeMockSnapshot());
  const md = formatDriftMarkdown(report);
  assert(md.includes("# Context Drift Report"), "Should have MD title");
  assert(md.includes("| Metric |"), "Should have stats table");
  assert(md.includes("No drift detected"), "Should say no drift");
  pass("testFormatMarkdown");
}

function testFormatJson() {
  const report = computeDrift(makeMockSnapshot(), makeMockSnapshot());
  const json = formatDriftJson(report);
  const parsed = JSON.parse(json) as DriftReport;
  assert(parsed.hashChanged === false, "JSON hashChanged should be false");
  assert(parsed.stats.patternDelta === 0, "JSON patternDelta should be 0");
  pass("testFormatJson");
}

function testFormatNoDriftMessage() {
  const report = computeDrift(makeMockSnapshot(), makeMockSnapshot());
  const text = formatDriftText(report);
  assert(text.includes("No drift detected"), "Should show no drift message");
  pass("testFormatNoDriftMessage");
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

async function testLoadSnapshot() {
  const root = await createProjectWithIndex();
  try {
    const snapshot = await loadSnapshot(join(root, ".uiq"));
    assert(typeof snapshot.meta.intelligenceHash === "string", "Should have hash");
    assert(snapshot.meta.buildNumber >= 1, "Build number >= 1");
    assert(snapshot.patternIds.length > 0, "Should have patterns");
    pass("testLoadSnapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDriftSaveCommand() {
  const root = await createProjectWithIndex();
  try {
    await runDriftCommand({ dir: root, save: true });
    const snapshotPath = join(root, ".uiq", "snapshot.json");
    const raw = await readFile(snapshotPath, "utf-8");
    const snapshot = JSON.parse(raw);
    assert(typeof snapshot.meta === "object", "Snapshot should have meta");
    assert(Array.isArray(snapshot.patternIds), "Snapshot should have patternIds");
    pass("testDriftSaveCommand");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDriftNoBaselineError() {
  const root = await createProjectWithIndex();
  try {
    await runDriftCommand({ dir: root });
    assert(false, "Should throw without baseline");
  } catch (err) {
    assert(err instanceof Error, "Should throw Error");
    assert(err.message.includes("baseline"), "Should mention baseline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testDriftNoBaselineError");
}

async function testDriftNoDriftDetected() {
  const root = await createProjectWithIndex();
  try {
    // Save baseline
    await runDriftCommand({ dir: root, save: true });

    // Capture drift output
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    await runDriftCommand({ dir: root, format: "text" });
    process.stdout.write = originalWrite;

    assert(output.includes("No drift detected"), "Should detect no drift");
    pass("testDriftNoDriftDetected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDriftAfterFileChange() {
  const root = await createProjectWithIndex();
  try {
    // Save baseline
    await runDriftCommand({ dir: root, save: true });

    // Add a new file and re-init
    await writeFile(
      join(root, "src", "Modal.tsx"),
      `export function Modal() { return <div>Modal</div>; }\n`,
    );
    execSync("node dist/cli.js init -d " + JSON.stringify(root), {
      cwd: join(__dirname, "..", ".."),
      stdio: "pipe",
    });

    // Check drift
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    await runDriftCommand({ dir: root, format: "text" });
    process.stdout.write = originalWrite;

    assert(output.includes("YES"), "Hash should have changed");
    assert(output.includes("[+]"), "Should show added patterns");
    pass("testDriftAfterFileChange");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDriftMissingUiqError() {
  const root = makeTestDir();
  await mkdir(root, { recursive: true });
  try {
    await runDriftCommand({ dir: root });
    assert(false, "Should throw for missing .uiq");
  } catch (err) {
    assert(err instanceof Error, "Should throw Error");
    assert(err.message.includes("init"), "Should suggest init");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testDriftMissingUiqError");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Drift Detection tests\n");

  console.log("Unit — computeDrift:");
  testNoDrift();
  testHashChanged();
  testPatternsAdded();
  testPatternsRemoved();
  testInsightsChanged();
  testStatsDelta();

  console.log("\nUnit — formatters:");
  testFormatText();
  testFormatMarkdown();
  testFormatJson();
  testFormatNoDriftMessage();

  console.log("\nIntegration:");
  await testLoadSnapshot();
  await testDriftSaveCommand();
  await testDriftNoBaselineError();
  await testDriftNoDriftDetected();
  await testDriftAfterFileChange();
  await testDriftMissingUiqError();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
