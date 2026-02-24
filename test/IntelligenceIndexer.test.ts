import { createHash } from "node:crypto";
import { mkdir, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IntelligenceIndexer } from "../src/indexer/IntelligenceIndexer.js";
import type {
  AnalyzerOutput,
  PatternResult,
  PatternType,
  AnalyzerId,
  PatternId,
  OutputHash,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertDeepEqual(a: unknown, b: unknown, msg: string): void {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}\n  expected: ${jb}\n  actual:   ${ja}`);
}

const ROOT = join(tmpdir(), "uiq-indexer-test-" + Date.now());

async function freshRoot(): Promise<string> {
  const dir = join(
    ROOT,
    String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makePattern(overrides?: Partial<PatternResult>): PatternResult {
  return {
    id: "src/Button.tsx:Button:1" as PatternId,
    type: "component",
    name: "Button",
    filePath: "src/Button.tsx",
    location: {
      file: "src/Button.tsx",
      start: { line: 1, column: 0 },
      end: { line: 10, column: 1 },
    },
    confidence: {
      value: 0.9,
      source: "naming",
      factors: [{ name: "naming", weight: 1, score: 0.9 }],
    },
    framework: "react",
    dependencies: [],
    properties: {},
    metadata: {},
    ...overrides,
  };
}

function makeOutput(
  name: string,
  version: string,
  patterns: PatternResult[],
): AnalyzerOutput {
  const payload = JSON.stringify({ patterns, diagnostics: [] });
  const hash = createHash("sha256").update(payload).digest("hex");
  return {
    analyzerId: `${name}@${version}` as AnalyzerId,
    patterns,
    diagnostics: [],
    hash: hash as OutputHash,
    duration: 50,
    stats: {
      totalFiles: patterns.length,
      analyzedFiles: patterns.length,
      cacheHits: 0,
      cacheMisses: patterns.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testBasicBuild() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern();
  const outputs = new Map([["react-analyzer", makeOutput("react-analyzer", "1.0.0", [btn])]]);

  const index = await indexer.build(outputs);

  assert(index.entries.size === 1, `Expected 1 entry, got ${index.entries.size}`);
  assert(index.entries.has(btn.id), "Should contain button pattern");
  assert(index.buildNumber === 1, `First build should be 1, got ${index.buildNumber}`);
  assert(typeof index.compositeHash === "string" && (index.compositeHash as string).length === 64, "compositeHash should be 64-char hex");

  console.log("PASS: testBasicBuild");
}

async function testMultipleAnalyzers() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern({ id: "src/Button.tsx:Button:1" as PatternId });
  const card = makePattern({
    id: "src/Card.vue:Card:1" as PatternId,
    name: "Card",
    filePath: "src/Card.vue",
    framework: "vue",
    type: "component",
  });

  const outputs = new Map([
    ["react-analyzer", makeOutput("react-analyzer", "1.0.0", [btn])],
    ["vue-analyzer", makeOutput("vue-analyzer", "1.0.0", [card])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.entries.size === 2, `Expected 2 entries, got ${index.entries.size}`);
  assert(index.entries.has(btn.id), "Should contain button");
  assert(index.entries.has(card.id), "Should contain card");

  console.log("PASS: testMultipleAnalyzers");
}

async function testPatternDeduplication() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const sharedId = "src/Button.tsx:Button:1" as PatternId;
  const btnV1 = makePattern({ id: sharedId, name: "ButtonV1" });
  const btnV2 = makePattern({ id: sharedId, name: "ButtonV2" });

  // Sorted order: "a-analyzer" < "b-analyzer", so b-analyzer's pattern wins
  const outputs = new Map([
    ["a-analyzer", makeOutput("a-analyzer", "1.0.0", [btnV1])],
    ["b-analyzer", makeOutput("b-analyzer", "1.0.0", [btnV2])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.entries.size === 1, "Duplicate IDs should merge to 1");
  assert(index.entries.get(sharedId)!.name === "ButtonV2", "Last writer (sorted) wins");

  console.log("PASS: testPatternDeduplication");
}

async function testDependencyEdgeExtraction() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const depId = "src/Icon.tsx:Icon:1" as PatternId;
  const btn = makePattern({
    id: "src/Button.tsx:Button:1" as PatternId,
    dependencies: [depId],
  });
  const icon = makePattern({
    id: depId,
    name: "Icon",
    filePath: "src/Icon.tsx",
  });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [btn, icon])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.edges.length === 1, `Expected 1 edge, got ${index.edges.length}`);
  assert(index.edges[0]!.from === btn.id, "Edge from should be Button");
  assert(index.edges[0]!.to === depId, "Edge to should be Icon");
  assert(index.edges[0]!.kind === "import", "Default edge kind should be import (no metadata.edges)");

  console.log("PASS: testDependencyEdgeExtraction");
}

async function testTypedEdgeKindsFromMetadata() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const hookId = "src/useAuth.ts:useAuth:1" as PatternId;
  const iconId = "src/Icon.tsx:Icon:1" as PatternId;
  const providerId = "src/ThemeProvider.tsx:ThemeProvider:1" as PatternId;

  const app = makePattern({
    id: "src/App.tsx:App:dep:1" as PatternId,
    name: "App:dependencies",
    filePath: "src/App.tsx",
    dependencies: [iconId, hookId, providerId],
    metadata: {
      edges: [
        { target: iconId, kind: "render", targetName: "Icon", targetFile: "src/Icon.tsx", confidence: 0.9 },
        { target: hookId, kind: "hook-usage", targetName: "useAuth", targetFile: "src/useAuth.ts", confidence: 0.85 },
        { target: providerId, kind: "provider", targetName: "ThemeProvider", targetFile: "src/ThemeProvider.tsx", confidence: 0.8 },
      ],
    },
  });
  const hook = makePattern({ id: hookId, name: "useAuth", filePath: "src/useAuth.ts", type: "utility" });
  const icon = makePattern({ id: iconId, name: "Icon", filePath: "src/Icon.tsx" });
  const provider = makePattern({ id: providerId, name: "ThemeProvider", filePath: "src/ThemeProvider.tsx" });

  const outputs = new Map([
    ["dep-analyzer", makeOutput("dep-analyzer", "1.0.0", [app, hook, icon, provider])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.edges.length === 3, `Expected 3 edges, got ${index.edges.length}`);

  // Edges are sorted by (from, to, kind) — all from same source, so sorted by to
  const edgeKinds = new Map(index.edges.map(e => [e.to, e.kind]));
  assert(edgeKinds.get(iconId) === "render", `Icon edge should be render, got ${edgeKinds.get(iconId)}`);
  assert(edgeKinds.get(hookId) === "hook-usage", `Hook edge should be hook-usage, got ${edgeKinds.get(hookId)}`);
  assert(edgeKinds.get(providerId) === "provider", `Provider edge should be provider, got ${edgeKinds.get(providerId)}`);

  console.log("PASS: testTypedEdgeKindsFromMetadata");
}

async function testFileIndex() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern({
    id: "src/components.tsx:Button:1" as PatternId,
    filePath: "src/components.tsx",
  });
  const card = makePattern({
    id: "src/components.tsx:Card:10" as PatternId,
    name: "Card",
    filePath: "src/components.tsx",
  });
  const nav = makePattern({
    id: "src/Nav.tsx:Nav:1" as PatternId,
    name: "Nav",
    filePath: "src/Nav.tsx",
  });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [btn, card, nav])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.fileIndex.size === 2, `Expected 2 file groups, got ${index.fileIndex.size}`);

  const compPatterns = index.fileIndex.get("src/components.tsx")!;
  assert(compPatterns.length === 2, "components.tsx should have 2 patterns");
  // Should be sorted
  assert(
    (compPatterns[0]! as string) < (compPatterns[1]! as string),
    "Pattern IDs should be sorted within file group",
  );

  const navPatterns = index.fileIndex.get("src/Nav.tsx")!;
  assert(navPatterns.length === 1, "Nav.tsx should have 1 pattern");

  console.log("PASS: testFileIndex");
}

async function testTypeIndex() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern({ id: "p1" as PatternId, type: "component" });
  const hook = makePattern({
    id: "p2" as PatternId,
    name: "useAuth",
    type: "hook",
    filePath: "src/useAuth.ts",
  });
  const util = makePattern({
    id: "p3" as PatternId,
    name: "formatDate",
    type: "utility",
    filePath: "src/utils.ts",
  });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [btn, hook, util])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.typeIndex.size === 3, `Expected 3 type groups, got ${index.typeIndex.size}`);
  assert(index.typeIndex.get("component")!.length === 1, "1 component");
  assert(index.typeIndex.get("hook")!.length === 1, "1 hook");
  assert(index.typeIndex.get("utility")!.length === 1, "1 utility");

  console.log("PASS: testTypeIndex");
}

async function testStatsComputation() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern({
    id: "p1" as PatternId,
    framework: "react",
    type: "component",
    filePath: "src/Button.tsx",
    dependencies: ["p2" as PatternId],
  });
  const card = makePattern({
    id: "p2" as PatternId,
    name: "Card",
    framework: "react",
    type: "component",
    filePath: "src/Card.tsx",
  });
  const hook = makePattern({
    id: "p3" as PatternId,
    name: "useAuth",
    framework: "vue",
    type: "hook",
    filePath: "src/useAuth.ts",
  });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [btn, card, hook])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.stats.totalPatterns === 3, `Expected 3 patterns, got ${index.stats.totalPatterns}`);
  assert(index.stats.totalEdges === 1, `Expected 1 edge, got ${index.stats.totalEdges}`);
  assert(index.stats.totalFiles === 3, `Expected 3 files, got ${index.stats.totalFiles}`);
  assert(index.stats.byFramework["react"] === 2, "react should have 2");
  assert(index.stats.byFramework["vue"] === 1, "vue should have 1");
  assert(index.stats.byType["component"] === 2, "component should have 2");
  assert(index.stats.byType["hook"] === 1, "hook should have 1");

  console.log("PASS: testStatsComputation");
}

async function testCompositeHashDeterminism() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern({ id: "p1" as PatternId });
  const card = makePattern({
    id: "p2" as PatternId,
    name: "Card",
    filePath: "src/Card.tsx",
  });

  // Same outputs, different insertion order
  const outputs1 = new Map([
    ["b-analyzer", makeOutput("b-analyzer", "1.0.0", [card])],
    ["a-analyzer", makeOutput("a-analyzer", "1.0.0", [btn])],
  ]);

  const outputs2 = new Map([
    ["a-analyzer", makeOutput("a-analyzer", "1.0.0", [btn])],
    ["b-analyzer", makeOutput("b-analyzer", "1.0.0", [card])],
  ]);

  const index1 = await indexer.build(outputs1);
  const index2 = await indexer.build(outputs2);

  assert(
    index1.compositeHash === index2.compositeHash,
    "Same outputs in different Map order should produce same compositeHash",
  );

  console.log("PASS: testCompositeHashDeterminism");
}

async function testCompositeHashChanges() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern({ id: "p1" as PatternId });
  const card = makePattern({
    id: "p2" as PatternId,
    name: "Card",
    filePath: "src/Card.tsx",
  });

  const outputs1 = new Map([["a", makeOutput("a", "1.0.0", [btn])]]);
  const outputs2 = new Map([["a", makeOutput("a", "1.0.0", [card])]]);

  const index1 = await indexer.build(outputs1);
  const index2 = await indexer.build(outputs2);

  assert(
    index1.compositeHash !== index2.compositeHash,
    "Different patterns should produce different compositeHash",
  );

  console.log("PASS: testCompositeHashChanges");
}

async function testBuildNumberIncrement() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [makePattern()])],
  ]);

  // First build
  const idx1 = await indexer.buildAndWrite(outputs);
  assert(idx1.buildNumber === 1, `First build should be 1, got ${idx1.buildNumber}`);

  // Second build — should read previous meta.json and increment
  const idx2 = await indexer.buildAndWrite(outputs);
  assert(idx2.buildNumber === 2, `Second build should be 2, got ${idx2.buildNumber}`);

  // Third build
  const idx3 = await indexer.buildAndWrite(outputs);
  assert(idx3.buildNumber === 3, `Third build should be 3, got ${idx3.buildNumber}`);

  console.log("PASS: testBuildNumberIncrement");
}

async function testWriteDirectoryStructure() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [makePattern()])],
  ]);

  await indexer.buildAndWrite(outputs);

  // Check directory structure
  const uiqDir = join(root, ".uiq");
  const uiqFiles = await readdir(uiqDir);
  assert(uiqFiles.includes("index.json"), "Should have index.json");
  assert(uiqFiles.includes("meta.json"), "Should have meta.json");
  assert(uiqFiles.includes("patterns"), "Should have patterns/ directory");

  const patternFiles = await readdir(join(uiqDir, "patterns"));
  assert(patternFiles.length === 1, `Expected 1 pattern file, got ${patternFiles.length}`);
  assert(patternFiles[0]!.endsWith(".json"), "Pattern files should be .json");

  console.log("PASS: testWriteDirectoryStructure");
}

async function testWriteIndexJson() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern();
  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [btn])],
  ]);

  await indexer.buildAndWrite(outputs);

  const raw = await readFile(join(root, ".uiq/index.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  assert(typeof parsed["buildNumber"] === "number", "index.json should have buildNumber");
  assert(typeof parsed["compositeHash"] === "string", "index.json should have compositeHash");
  assert(typeof parsed["entries"] === "object", "index.json should have entries");
  assert(Array.isArray(parsed["edges"]), "index.json should have edges array");
  assert(typeof parsed["fileIndex"] === "object", "index.json should have fileIndex");
  assert(typeof parsed["typeIndex"] === "object", "index.json should have typeIndex");
  assert(typeof parsed["stats"] === "object", "index.json should have stats");

  // Verify entry is present
  const entries = parsed["entries"] as Record<string, unknown>;
  assert(entries[btn.id as string] !== undefined, "Button entry should be in entries");

  console.log("PASS: testWriteIndexJson");
}

async function testWriteMetaJson() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root, toolVersion: "2.0.0", schemaVersion: 3 });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [makePattern()])],
  ]);

  await indexer.buildAndWrite(outputs);

  const raw = await readFile(join(root, ".uiq/meta.json"), "utf-8");
  const meta = JSON.parse(raw) as Record<string, unknown>;

  assert(typeof meta["intelligenceHash"] === "string", "meta should have intelligenceHash");
  assert((meta["intelligenceHash"] as string).length === 64, "intelligenceHash should be 64-char hex");
  assert(typeof meta["generatedAt"] === "string", "meta should have generatedAt");
  assert(meta["toolVersion"] === "2.0.0", `toolVersion should be 2.0.0, got ${meta["toolVersion"]}`);
  assert(meta["schemaVersion"] === 3, `schemaVersion should be 3, got ${meta["schemaVersion"]}`);
  assert(meta["buildNumber"] === 1, `buildNumber should be 1, got ${meta["buildNumber"]}`);
  assert(typeof meta["compositeHash"] === "string", "meta should have compositeHash");
  assert(typeof meta["stats"] === "object", "meta should have stats");

  // Verify generatedAt is valid ISO
  const date = new Date(meta["generatedAt"] as string);
  assert(!isNaN(date.getTime()), "generatedAt should be valid ISO date");

  console.log("PASS: testWriteMetaJson");
}

async function testIntelligenceHashMatchesContent() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [makePattern()])],
  ]);

  await indexer.buildAndWrite(outputs);

  const indexContent = await readFile(join(root, ".uiq/index.json"), "utf-8");
  const expectedHash = createHash("sha256").update(indexContent).digest("hex");

  const meta = JSON.parse(await readFile(join(root, ".uiq/meta.json"), "utf-8"));
  assert(
    meta.intelligenceHash === expectedHash,
    `intelligenceHash mismatch: meta=${meta.intelligenceHash} expected=${expectedHash}`,
  );

  console.log("PASS: testIntelligenceHashMatchesContent");
}

async function testPatternFilesWritten() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const btn = makePattern({ id: "src/Button.tsx:Button:1" as PatternId });
  const card = makePattern({
    id: "src/Card.tsx:Card:5" as PatternId,
    name: "Card",
    filePath: "src/Card.tsx",
  });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [btn, card])],
  ]);

  await indexer.buildAndWrite(outputs);

  const patternDir = join(root, ".uiq/patterns");
  const files = await readdir(patternDir);
  assert(files.length === 2, `Expected 2 pattern files, got ${files.length}`);

  // Read one pattern file and verify content
  // PatternId "src/Button.tsx:Button:1" → sanitized "src_Button.tsx__Button__1.json"
  const btnFile = files.find((f) => f.includes("Button"));
  assert(btnFile !== undefined, "Should have a Button pattern file");

  const btnContent = JSON.parse(await readFile(join(patternDir, btnFile!), "utf-8"));
  assert(btnContent.name === "Button", "Pattern file should contain Button pattern");
  assert(btnContent.id === "src/Button.tsx:Button:1", "Pattern ID should be preserved");

  console.log("PASS: testPatternFilesWritten");
}

async function testDeterministicOutput() {
  const root1 = await freshRoot();
  const root2 = await freshRoot();

  const btn = makePattern({ id: "p1" as PatternId });
  const card = makePattern({
    id: "p2" as PatternId,
    name: "Card",
    filePath: "src/Card.tsx",
  });

  const outputs = new Map([
    ["b-analyzer", makeOutput("b-analyzer", "1.0.0", [card])],
    ["a-analyzer", makeOutput("a-analyzer", "1.0.0", [btn])],
  ]);

  const indexer1 = new IntelligenceIndexer({ rootPath: root1 });
  const indexer2 = new IntelligenceIndexer({ rootPath: root2 });

  await indexer1.buildAndWrite(outputs);
  await indexer2.buildAndWrite(outputs);

  const json1 = await readFile(join(root1, ".uiq/index.json"), "utf-8");
  const json2 = await readFile(join(root2, ".uiq/index.json"), "utf-8");

  assert(json1 === json2, "Same inputs should produce byte-identical index.json");

  console.log("PASS: testDeterministicOutput");
}

async function testEmptyOutput() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const outputs = new Map<string, AnalyzerOutput>();

  const index = await indexer.build(outputs);

  assert(index.entries.size === 0, "Empty outputs should produce 0 entries");
  assert(index.edges.length === 0, "Empty outputs should produce 0 edges");
  assert(index.fileIndex.size === 0, "Empty outputs should produce 0 file groups");
  assert(index.typeIndex.size === 0, "Empty outputs should produce 0 type groups");
  assert(index.stats.totalPatterns === 0, "totalPatterns should be 0");
  assert(index.stats.totalEdges === 0, "totalEdges should be 0");
  assert(index.stats.totalFiles === 0, "totalFiles should be 0");
  assert(index.buildNumber === 1, "First build number should be 1");

  // compositeHash should still be valid (SHA-256 of empty string)
  assert(typeof index.compositeHash === "string", "compositeHash should exist");
  assert((index.compositeHash as string).length === 64, "compositeHash should be 64-char hex");

  console.log("PASS: testEmptyOutput");
}

async function testEdgeSorting() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const p1 = makePattern({
    id: "z:Z:1" as PatternId,
    name: "Z",
    filePath: "z.tsx",
    dependencies: ["a:A:1" as PatternId, "m:M:1" as PatternId],
  });
  const p2 = makePattern({
    id: "a:A:1" as PatternId,
    name: "A",
    filePath: "a.tsx",
    dependencies: ["m:M:1" as PatternId],
  });
  const p3 = makePattern({
    id: "m:M:1" as PatternId,
    name: "M",
    filePath: "m.tsx",
  });

  const outputs = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [p1, p2, p3])],
  ]);

  const index = await indexer.build(outputs);

  assert(index.edges.length === 3, `Expected 3 edges, got ${index.edges.length}`);

  // Edges should be sorted by (from, to, kind)
  for (let i = 0; i < index.edges.length - 1; i++) {
    const curr = index.edges[i]!;
    const next = index.edges[i + 1]!;
    const cmp =
      ((curr.from as string) < (next.from as string) ? -1 : (curr.from as string) > (next.from as string) ? 1 : 0) ||
      ((curr.to as string) < (next.to as string) ? -1 : (curr.to as string) > (next.to as string) ? 1 : 0);
    assert(cmp <= 0, `Edges should be sorted: ${JSON.stringify(curr)} should come before ${JSON.stringify(next)}`);
  }

  console.log("PASS: testEdgeSorting");
}

async function testDuplicatePatternIdDetection() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  // Same PatternId from two different analyzers
  const sharedId = "src/Button.tsx:Button:1" as PatternId;
  const p1 = makePattern({ id: sharedId, name: "Button", filePath: "src/Button.tsx" });
  const p2 = makePattern({
    id: sharedId,
    name: "Button",
    filePath: "src/Button.tsx",
    type: "utility" as PatternType, // different type to verify winner
  });

  const outputs = new Map([
    ["alpha-analyzer", makeOutput("alpha-analyzer", "1.0.0", [p1])],
    ["beta-analyzer", makeOutput("beta-analyzer", "1.0.0", [p2])],
  ]);

  const index = await indexer.build(outputs);

  // Pipeline should not break
  assert(index.entries.size === 1, `Expected 1 entry (deduplicated), got ${index.entries.size}`);

  // Winner should be beta-analyzer (last in sorted order)
  const winner = index.entries.get(sharedId)!;
  assert(winner.type === "utility", `Winner should be beta-analyzer's pattern (utility), got ${winner.type}`);

  // Diagnostics should report the duplicate
  const diags = indexer.buildDiagnostics;
  assert(diags.length === 1, `Expected 1 diagnostic, got ${diags.length}`);
  assert(diags[0]!.severity === "warning", `severity should be warning, got ${diags[0]!.severity}`);
  assert(diags[0]!.message === "Duplicate PatternId detected", `message mismatch: ${diags[0]!.message}`);
  assert(diags[0]!.patternId === (sharedId as string), `patternId mismatch`);
  assert(diags[0]!.analyzers!.length === 2, "should list 2 analyzers");
  assert(diags[0]!.analyzers![0] === "alpha-analyzer", "analyzers should be sorted");
  assert(diags[0]!.analyzers![1] === "beta-analyzer", "analyzers should be sorted");
  assert(diags[0]!.winner === "beta-analyzer", `winner should be beta-analyzer, got ${diags[0]!.winner}`);

  console.log("PASS: testDuplicatePatternIdDetection");
}

async function testOrphanPatternCleanup() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  // Build 1 — 3 patterns
  const p1 = makePattern({ id: "a:A:1" as PatternId, name: "A", filePath: "a.tsx" });
  const p2 = makePattern({ id: "b:B:1" as PatternId, name: "B", filePath: "b.tsx" });
  const p3 = makePattern({ id: "c:C:1" as PatternId, name: "C", filePath: "c.tsx" });
  const outputs1 = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [p1, p2, p3])],
  ]);
  await indexer.buildAndWrite(outputs1);

  const patternsDir = join(root, ".uiq/patterns");
  const files1 = (await readdir(patternsDir)).sort();
  assert(files1.length === 3, `Build 1: expected 3 pattern files, got ${files1.length}`);

  // Build 2 — only 2 patterns (p3 removed)
  const outputs2 = new Map([
    ["analyzer", makeOutput("analyzer", "1.0.0", [p1, p2])],
  ]);
  await indexer.buildAndWrite(outputs2);

  const files2 = (await readdir(patternsDir)).sort();
  assert(files2.length === 2, `Build 2: expected 2 pattern files, got ${files2.length}`);

  // Verify the orphan (p3's file) was removed
  const hasOrphan = files2.some((f) => f.includes("c__C"));
  assert(!hasOrphan, "Orphan pattern file for 'c:C:1' should have been removed");

  console.log("PASS: testOrphanPatternCleanup");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  try {
    await testBasicBuild();
    await testMultipleAnalyzers();
    await testPatternDeduplication();
    await testDependencyEdgeExtraction();
    await testTypedEdgeKindsFromMetadata();
    await testFileIndex();
    await testTypeIndex();
    await testStatsComputation();
    await testCompositeHashDeterminism();
    await testCompositeHashChanges();
    await testBuildNumberIncrement();
    await testWriteDirectoryStructure();
    await testWriteIndexJson();
    await testWriteMetaJson();
    await testIntelligenceHashMatchesContent();
    await testPatternFilesWritten();
    await testDeterministicOutput();
    await testEmptyOutput();
    await testEdgeSorting();
    await testDuplicatePatternIdDetection();
    await testOrphanPatternCleanup();

    console.log("\nAll 21 tests passed.");
  } finally {
    await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
