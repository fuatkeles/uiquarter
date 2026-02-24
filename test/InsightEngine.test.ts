import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InsightEngine } from "../src/core/InsightEngine.js";
import { IntelligenceIndexer } from "../src/indexer/IntelligenceIndexer.js";
import { stableStringify } from "../src/core/utils.js";
import type {
  AnalyzerId,
  AnalyzerOutput,
  DependencyEdge,
  IndexStats,
  IntelligenceIndex,
  OutputHash,
  PatternId,
  PatternResult,
  PatternType,
} from "../src/types/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const ROOT = join(tmpdir(), "uiq-insight-test-" + Date.now());

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
    id: "src/App.tsx:App:1" as PatternId,
    type: "component",
    name: "App",
    filePath: "src/App.tsx",
    location: {
      file: "src/App.tsx",
      start: { line: 1, column: 0 },
      end: { line: 20, column: 1 },
    },
    confidence: {
      value: 0.9,
      source: "test",
      factors: [{ name: "test", weight: 1, score: 0.9 }],
    },
    framework: "react",
    dependencies: [],
    properties: {},
    metadata: {},
    ...overrides,
  };
}

function makeDepPattern(
  source: PatternResult,
  targets: readonly PatternId[],
  kind: DependencyEdge["kind"] = "render",
): PatternResult {
  return makePattern({
    id: `${source.filePath}:${source.name}:dep:1` as PatternId,
    type: source.type,
    name: `${source.name}:dependencies`,
    filePath: source.filePath,
    metadata: {
      sourcePatternId: source.id,
      edges: targets.map((target) => ({
        target,
        kind,
        confidence: 1,
      })),
    },
    dependencies: [...targets],
  });
}

function makeDirectoryPattern(
  dirPath: string,
  role: string,
  roleScore: number,
  extra?: Readonly<Record<string, unknown>>,
): PatternResult {
  return makePattern({
    id: `${dirPath}:directory:1` as PatternId,
    type: "utility",
    name: "directory",
    filePath: dirPath,
    metadata: {
      role,
      roleScore,
      fileCount: 3,
      namingConvention: "PascalCase",
      hasBarrel: true,
      ...(extra ?? {}),
    },
  });
}

function addRenderLink(
  source: PatternResult,
  target: PatternResult,
  patterns: PatternResult[],
  edges: DependencyEdge[],
): void {
  const depPattern = makeDepPattern(source, [target.id], "render");
  patterns.push(depPattern);
  edges.push({
    from: depPattern.id,
    to: target.id,
    kind: "render",
  });
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(input).sort()) {
    out[key] = input[key]!;
  }
  return out;
}

function makeIndex(
  patterns: readonly PatternResult[],
  edges: readonly DependencyEdge[],
): IntelligenceIndex {
  const entries = new Map<PatternId, PatternResult>();
  for (const pattern of [...patterns].sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0))) {
    entries.set(pattern.id, pattern);
  }

  const fileIndexMap = new Map<string, PatternId[]>();
  const typeIndexMap = new Map<PatternType, PatternId[]>();
  const byFramework: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const pattern of entries.values()) {
    const fileArr = fileIndexMap.get(pattern.filePath);
    if (fileArr === undefined) {
      fileIndexMap.set(pattern.filePath, [pattern.id]);
    } else {
      fileArr.push(pattern.id);
    }

    const typeArr = typeIndexMap.get(pattern.type);
    if (typeArr === undefined) {
      typeIndexMap.set(pattern.type, [pattern.id]);
    } else {
      typeArr.push(pattern.id);
    }

    byFramework[pattern.framework] = (byFramework[pattern.framework] ?? 0) + 1;
    byType[pattern.type] = (byType[pattern.type] ?? 0) + 1;
  }

  for (const ids of fileIndexMap.values()) {
    ids.sort();
  }
  for (const ids of typeIndexMap.values()) {
    ids.sort();
  }

  const fileIndex = new Map(
    [...fileIndexMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ) as ReadonlyMap<string, readonly PatternId[]>;

  const typeIndex = new Map(
    [...typeIndexMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ) as ReadonlyMap<PatternType, readonly PatternId[]>;

  const stats: IndexStats = {
    totalPatterns: entries.size,
    totalEdges: edges.length,
    totalFiles: fileIndex.size,
    byFramework: sortRecord(byFramework),
    byType: sortRecord(byType),
  };

  return {
    schemaVersion: 1,
    buildNumber: 1,
    compositeHash: "0".repeat(64) as OutputHash,
    entries,
    edges: [...edges].sort((a, b) =>
      ((a.from as string) < (b.from as string) ? -1 : (a.from as string) > (b.from as string) ? 1 : 0) ||
      ((a.to as string) < (b.to as string) ? -1 : (a.to as string) > (b.to as string) ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    ),
    fileIndex,
    typeIndex,
    stats,
  };
}

function makeOutput(
  name: string,
  version: string,
  patterns: readonly PatternResult[],
): AnalyzerOutput {
  const payload = JSON.stringify({ patterns, diagnostics: [] });
  const hash = createHash("sha256").update(payload).digest("hex");
  return {
    analyzerId: `${name}@${version}` as AnalyzerId,
    patterns: [...patterns],
    diagnostics: [],
    hash: hash as OutputHash,
    duration: 1,
    stats: {
      totalFiles: patterns.length,
      analyzedFiles: patterns.length,
      cacheHits: 0,
      cacheMisses: patterns.length,
    },
  };
}

async function testHubComponentDetection() {
  const hub = makePattern({
    id: "src/components/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/components/Button.tsx",
  });

  const dependents: PatternResult[] = [];
  const depPatterns: PatternResult[] = [];
  const edges: DependencyEdge[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const dependent = makePattern({
      id: `src/features/F${i}.tsx:F${i}:1` as PatternId,
      name: `F${i}`,
      filePath: `src/features/F${i}.tsx`,
    });
    dependents.push(dependent);
    const depPattern = makeDepPattern(dependent, [hub.id], "render");
    depPatterns.push(depPattern);
    edges.push({
      from: depPattern.id,
      to: hub.id,
      kind: "render",
    });
  }

  const index = makeIndex([hub, ...dependents, ...depPatterns], edges);
  const engine = new InsightEngine();
  const result = engine.generate(index);
  const insights = result.insights;

  const hubs = insights.filter((insight) => insight.category === "hub-component");
  assert(hubs.length === 1, `Expected 1 hub insight, got ${hubs.length}`);
  assert(hubs[0]!.id === `hub-component:${hub.id as string}`, "Hub insight id mismatch");
  assert(hubs[0]!.relatedPatterns[0] === hub.id, "Hub pattern should be first related pattern");
  assert((hubs[0]!.metadata["renderInDegree"] as number) === 6, "renderInDegree should be 6");
  assert(typeof result.hash === "string" && result.hash.length === 64, "result.hash should be 64-char hex");
  assert(result.stats.total === insights.length, "stats.total should match insight count");
  assert((result.stats.byType["hub-component"] ?? 0) === 1, "byType should count hub-component");

  console.log("PASS: testHubComponentDetection");
}

async function testOrphanComponentDetection() {
  const orphan = makePattern({
    id: "src/components/Legacy.tsx:Legacy:1" as PatternId,
    name: "Legacy",
    filePath: "src/components/Legacy.tsx",
  });

  const child = makePattern({
    id: "src/components/Child.tsx:Child:1" as PatternId,
    name: "Child",
    filePath: "src/components/Child.tsx",
  });

  const orphanDep = makeDepPattern(orphan, [child.id], "render");

  const index = makeIndex(
    [orphan, child, orphanDep],
    [
      {
        from: orphanDep.id,
        to: child.id,
        kind: "render",
      },
    ],
  );

  const engine = new InsightEngine();
  const result = engine.generate(index);
  const insights = result.insights;
  const orphans = insights.filter((insight) => insight.category === "orphan-component");

  assert(
    orphans.some((insight) => insight.id === `orphan-component:${orphan.id as string}`),
    "Legacy should be detected as orphan component",
  );

  const legacy = orphans.find((insight) => insight.id === `orphan-component:${orphan.id as string}`);
  assert(legacy !== undefined, "Legacy orphan insight should exist");
  assert(legacy!.severity === "warning", `Legacy orphan severity should be warning, got ${legacy!.severity}`);
  assert((result.stats.byType["orphan-component"] ?? 0) >= 1, "byType should include orphan-component");

  console.log("PASS: testOrphanComponentDetection");
}

async function testDependencyCycleDetection() {
  const a = makePattern({
    id: "src/A.tsx:A:1" as PatternId,
    name: "A",
    filePath: "src/A.tsx",
  });
  const b = makePattern({
    id: "src/B.tsx:B:1" as PatternId,
    name: "B",
    filePath: "src/B.tsx",
  });
  const c = makePattern({
    id: "src/C.tsx:C:1" as PatternId,
    name: "C",
    filePath: "src/C.tsx",
  });

  const cycle = makePattern({
    id: ".:dependency-cycle:1" as PatternId,
    type: "utility",
    name: "dependency-cycle",
    filePath: ".",
    metadata: {
      cycleIndex: 1,
      members: [a.id, b.id, c.id, a.id],
      memberNames: ["A", "B", "C"],
      length: 4,
      edgeKinds: ["render", "render", "render", "render"],
    },
  });

  const index = makeIndex([a, b, c, cycle], []);
  const engine = new InsightEngine();
  const result = engine.generate(index);
  const insights = result.insights;
  const cycles = insights.filter((insight) => insight.category === "dependency-cycle");

  assert(cycles.length === 1, `Expected 1 cycle insight, got ${cycles.length}`);
  assert(cycles[0]!.severity === "warning", `Cycle severity should be warning, got ${cycles[0]!.severity}`);
  assert((cycles[0]!.metadata["length"] as number) === 4, "Cycle length should be 4");
  assert((result.stats.byType["dependency-cycle"] ?? 0) === 1, "byType should count dependency-cycle");

  console.log("PASS: testDependencyCycleDetection");
}

async function testMixedStylingDetection() {
  const profile = makePattern({
    id: ".:styling-profile:1" as PatternId,
    type: "utility",
    name: "styling-profile",
    filePath: ".",
    metadata: {
      primaryApproach: "tailwind",
      technologyTally: {
        tailwind: 4,
        emotion: 2,
        "css-modules": 2,
        "plain-css": 1,
      },
      totalStyleFiles: 3,
      totalStyledSourceFiles: 4,
    },
  });

  const sourceStyling = makePattern({
    id: "src/App.tsx:styling:1" as PatternId,
    type: "utility",
    name: "styling",
    filePath: "src/App.tsx",
    metadata: {
      tailwind: true,
      "inline-styles": true,
      emotion: false,
      "styled-components": false,
      "vanilla-extract": false,
      "css-modules": false,
    },
  });

  const index = makeIndex([profile, sourceStyling], []);
  const engine = new InsightEngine();
  const result = engine.generate(index);
  const insights = result.insights;
  const mixed = insights.filter((insight) => insight.category === "mixed-styling");

  assert(mixed.length >= 2, `Expected at least 2 mixed-styling insights, got ${mixed.length}`);
  assert(
    mixed.some((insight) => insight.id === "mixed-styling:project"),
    "Project mixed-styling insight should exist",
  );
  assert(
    mixed.some((insight) => insight.id === "mixed-styling:file:src/App.tsx"),
    "File-level mixed-styling insight should exist",
  );
  assert((result.stats.byType["mixed-styling"] ?? 0) >= 2, "byType should include mixed-styling");

  console.log("PASS: testMixedStylingDetection");
}

async function testDeepDependencyChain3Hop() {
  const a = makePattern({ id: "src/A.tsx:A:1" as PatternId, name: "A", filePath: "src/A.tsx" });
  const b = makePattern({ id: "src/B.tsx:B:1" as PatternId, name: "B", filePath: "src/B.tsx" });
  const c = makePattern({ id: "src/C.tsx:C:1" as PatternId, name: "C", filePath: "src/C.tsx" });
  const d = makePattern({ id: "src/D.tsx:D:1" as PatternId, name: "D", filePath: "src/D.tsx" });

  const patterns: PatternResult[] = [a, b, c, d];
  const edges: DependencyEdge[] = [];
  addRenderLink(a, b, patterns, edges);
  addRenderLink(b, c, patterns, edges);
  addRenderLink(c, d, patterns, edges);

  const index = makeIndex(patterns, edges);
  const engine = new InsightEngine({ deepChainThreshold: 2 });
  const result = engine.generate(index);
  const deep = result.insights.filter((insight) => insight.category === "deep-dependency-chain");

  assert(deep.length >= 1, "Expected deep-dependency-chain insight for 3-hop chain");
  assert(
    deep.some((insight) => (insight.metadata["leafPatternId"] as string | undefined) === (d.id as string)),
    "Deep chain leaf should include D",
  );

  console.log("PASS: testDeepDependencyChain3Hop");
}

async function testDeepDependencyChain10Hop() {
  const patterns: PatternResult[] = [];
  const edges: DependencyEdge[] = [];
  for (let i = 0; i <= 10; i += 1) {
    patterns.push(makePattern({
      id: `src/N${i}.tsx:N${i}:1` as PatternId,
      name: `N${i}`,
      filePath: `src/N${i}.tsx`,
    }));
  }

  for (let i = 0; i < 10; i += 1) {
    addRenderLink(patterns[i]!, patterns[i + 1]!, patterns, edges);
  }

  const index = makeIndex(patterns, edges);
  const engine = new InsightEngine();
  const result = engine.generate(index);
  const deep = result.insights.filter((insight) => insight.category === "deep-dependency-chain");

  assert(deep.length >= 1, "Expected deep-dependency-chain insight for >=10 hop chain");
  assert(
    (deep[0]!.metadata["depth"] as number) > 8,
    `Depth should exceed default threshold, got ${String(deep[0]!.metadata["depth"])}`,
  );

  console.log("PASS: testDeepDependencyChain10Hop");
}

async function testDeepDependencyChainWithCycle() {
  const root = makePattern({ id: "src/Root.tsx:Root:1" as PatternId, name: "Root", filePath: "src/Root.tsx" });
  const a = makePattern({ id: "src/A.tsx:A:1" as PatternId, name: "A", filePath: "src/A.tsx" });
  const b = makePattern({ id: "src/B.tsx:B:1" as PatternId, name: "B", filePath: "src/B.tsx" });
  const c = makePattern({ id: "src/C.tsx:C:1" as PatternId, name: "C", filePath: "src/C.tsx" });

  const patterns: PatternResult[] = [root, a, b, c];
  const edges: DependencyEdge[] = [];
  addRenderLink(root, a, patterns, edges);
  addRenderLink(a, b, patterns, edges);
  addRenderLink(b, c, patterns, edges);
  addRenderLink(c, a, patterns, edges); // cycle

  const index = makeIndex(patterns, edges);
  const engine = new InsightEngine({ deepChainThreshold: 1 });
  const result = engine.generate(index);
  const deep = result.insights.filter((insight) => insight.category === "deep-dependency-chain");

  assert(deep.length >= 1, "Expected deep chain insight with cycle present");
  assert(
    Array.isArray(deep[0]!.metadata["chain"]) && (deep[0]!.metadata["chain"] as unknown[]).length >= 3,
    "Deep chain metadata should include a valid chain",
  );

  console.log("PASS: testDeepDependencyChainWithCycle");
}

async function testDeepDependencyChainDeterministic() {
  const patterns: PatternResult[] = [];
  const edges: DependencyEdge[] = [];
  for (let i = 0; i <= 6; i += 1) {
    patterns.push(makePattern({
      id: `src/C${i}.tsx:C${i}:1` as PatternId,
      name: `C${i}`,
      filePath: `src/C${i}.tsx`,
    }));
  }

  for (let i = 0; i < 6; i += 1) {
    addRenderLink(patterns[i]!, patterns[i + 1]!, patterns, edges);
  }

  const index = makeIndex(patterns, edges);
  const engine = new InsightEngine({ deepChainThreshold: 2 });
  const r1 = engine.generate(index);
  const r2 = engine.generate(index);
  assert(r1.hash === r2.hash, "Deep chain analysis hash should be deterministic");

  console.log("PASS: testDeepDependencyChainDeterministic");
}

async function testDeepDependencyChainMultipleRoots() {
  // Chain 1: R1 -> A1 -> A2 -> A3 (depth 3)
  const r1 = makePattern({ id: "src/R1.tsx:R1:1" as PatternId, name: "R1", filePath: "src/R1.tsx" });
  const a1 = makePattern({ id: "src/A1.tsx:A1:1" as PatternId, name: "A1", filePath: "src/A1.tsx" });
  const a2 = makePattern({ id: "src/A2.tsx:A2:1" as PatternId, name: "A2", filePath: "src/A2.tsx" });
  const a3 = makePattern({ id: "src/A3.tsx:A3:1" as PatternId, name: "A3", filePath: "src/A3.tsx" });

  // Chain 2: R2 -> B1 -> B2 -> B3 -> B4 (depth 4)
  const r2 = makePattern({ id: "src/R2.tsx:R2:1" as PatternId, name: "R2", filePath: "src/R2.tsx" });
  const b1 = makePattern({ id: "src/B1.tsx:B1:1" as PatternId, name: "B1", filePath: "src/B1.tsx" });
  const b2 = makePattern({ id: "src/B2.tsx:B2:1" as PatternId, name: "B2", filePath: "src/B2.tsx" });
  const b3 = makePattern({ id: "src/B3.tsx:B3:1" as PatternId, name: "B3", filePath: "src/B3.tsx" });
  const b4 = makePattern({ id: "src/B4.tsx:B4:1" as PatternId, name: "B4", filePath: "src/B4.tsx" });

  const patterns: PatternResult[] = [r1, a1, a2, a3, r2, b1, b2, b3, b4];
  const edges: DependencyEdge[] = [];
  addRenderLink(r1, a1, patterns, edges);
  addRenderLink(a1, a2, patterns, edges);
  addRenderLink(a2, a3, patterns, edges);
  addRenderLink(r2, b1, patterns, edges);
  addRenderLink(b1, b2, patterns, edges);
  addRenderLink(b2, b3, patterns, edges);
  addRenderLink(b3, b4, patterns, edges);

  const index = makeIndex(patterns, edges);
  const engine = new InsightEngine({ deepChainThreshold: 2 });
  const result = engine.generate(index);
  const deep = result.insights.filter((insight) => insight.category === "deep-dependency-chain");

  assert(deep.length >= 2, `Expected at least 2 deep chain insights from multiple roots, got ${deep.length}`);

  const depths = deep.map((insight) => insight.metadata["depth"] as number);
  assert(depths.some((d) => d >= 4), "Should detect chain with depth >= 4");
  assert(depths.some((d) => d === 3), "Should detect chain with depth 3");

  // Verify both leaves are distinct
  const leaves = deep.map((insight) => insight.metadata["leafPatternId"] as string);
  assert(new Set(leaves).size === deep.length, "Each deep chain insight should have a distinct leaf");

  console.log("PASS: testDeepDependencyChainMultipleRoots");
}

async function testDeepDependencyChainNoChains() {
  // Short chain: A -> B -> C (depth 2, below default threshold of 8)
  const a = makePattern({ id: "src/X.tsx:X:1" as PatternId, name: "X", filePath: "src/X.tsx" });
  const b = makePattern({ id: "src/Y.tsx:Y:1" as PatternId, name: "Y", filePath: "src/Y.tsx" });
  const c = makePattern({ id: "src/Z.tsx:Z:1" as PatternId, name: "Z", filePath: "src/Z.tsx" });

  const patterns: PatternResult[] = [a, b, c];
  const edges: DependencyEdge[] = [];
  addRenderLink(a, b, patterns, edges);
  addRenderLink(b, c, patterns, edges);

  const index = makeIndex(patterns, edges);
  const engine = new InsightEngine(); // default threshold = 8
  const result = engine.generate(index);
  const deep = result.insights.filter((insight) => insight.category === "deep-dependency-chain");

  assert(deep.length === 0, `Expected 0 deep chain insights for 2-hop chain with threshold 8, got ${deep.length}`);

  console.log("PASS: testDeepDependencyChainNoChains");
}

async function testGodComponentDetection() {
  const god = makePattern({
    id: "src/components/God.tsx:God:1" as PatternId,
    name: "God",
    filePath: "src/components/God.tsx",
  });

  const patterns: PatternResult[] = [god];
  const edges: DependencyEdge[] = [];
  for (let i = 1; i <= 11; i += 1) {
    const child = makePattern({
      id: `src/components/C${i}.tsx:C${i}:1` as PatternId,
      name: `C${i}`,
      filePath: `src/components/C${i}.tsx`,
    });
    patterns.push(child);
    addRenderLink(god, child, patterns, edges);
  }

  const result = new InsightEngine().generate(makeIndex(patterns, edges));
  const smell = result.insights.find(
    (insight) =>
      insight.category === "architectural-smell" &&
      insight.metadata["subType"] === "god-component",
  );
  assert(smell !== undefined, "God component smell should be detected");

  console.log("PASS: testGodComponentDetection");
}

async function testWrongDirectoryDetection() {
  const misplaced = makePattern({
    id: "src/utils/Widget.tsx:Widget:1" as PatternId,
    name: "Widget",
    filePath: "src/utils/Widget.tsx",
  });

  const dir = makeDirectoryPattern("src/utils", "utils", 0.95);
  const index = makeIndex([misplaced, dir], []);
  const result = new InsightEngine().generate(index);
  const smell = result.insights.find(
    (insight) =>
      insight.category === "architectural-smell" &&
      insight.metadata["subType"] === "wrong-directory",
  );
  assert(smell !== undefined, "Wrong-directory smell should be detected");

  console.log("PASS: testWrongDirectoryDetection");
}

async function testExcessivePropsDetection() {
  const heavy = makePattern({
    id: "src/components/Heavy.tsx:Heavy:1" as PatternId,
    name: "Heavy",
    filePath: "src/components/Heavy.tsx",
    metadata: {
      propCount: 20,
      requiredPropCount: 5,
    },
  });

  const result = new InsightEngine().generate(makeIndex([heavy], []));
  const smell = result.insights.find(
    (insight) =>
      insight.category === "architectural-smell" &&
      insight.metadata["subType"] === "excessive-props",
  );
  assert(smell !== undefined, "Excessive-props smell should be detected");

  console.log("PASS: testExcessivePropsDetection");
}

async function testInconsistentNamingDetection() {
  const conventions = makePattern({
    id: ".:conventions:1" as PatternId,
    type: "utility",
    name: "conventions",
    filePath: ".",
    confidence: {
      value: 0.9,
      source: "test",
      factors: [{ name: "sample", weight: 1, score: 0.9 }],
    },
    metadata: {
      dominantFileNaming: "PascalCase",
    },
  });

  const dir = makeDirectoryPattern("src/widgets", "components", 0.8, {
    namingConvention: "camelCase",
    fileCount: 4,
  });

  const result = new InsightEngine().generate(makeIndex([conventions, dir], []));
  const smell = result.insights.find(
    (insight) =>
      insight.category === "architectural-smell" &&
      insight.metadata["subType"] === "inconsistent-naming",
  );
  assert(smell !== undefined, "Inconsistent-naming smell should be detected");

  console.log("PASS: testInconsistentNamingDetection");
}

async function testMissingBarrelExposureDetection() {
  const dir = makeDirectoryPattern("src/components", "components", 0.85, {
    fileCount: 6,
    hasBarrel: false,
  });

  const result = new InsightEngine().generate(makeIndex([dir], []));
  const smell = result.insights.find(
    (insight) =>
      insight.category === "architectural-smell" &&
      insight.metadata["subType"] === "missing-barrel",
  );
  assert(smell !== undefined, "Missing-barrel smell should be detected");

  console.log("PASS: testMissingBarrelExposureDetection");
}

async function testCategoryLimitSeverityPriority() {
  const patterns: PatternResult[] = [];
  const edges: DependencyEdge[] = [];

  // Error hubs (degree 3) — IDs sort LAST alphabetically (z_)
  // With sort-by-ID these would be dropped; with severity sort they are retained first
  for (let i = 0; i < 5; i += 1) {
    const hub = makePattern({
      id: `src/z_err_${i}.tsx:ZErr${i}:1` as PatternId,
      name: `ZErr${i}`,
      filePath: `src/z_err_${i}.tsx`,
    });
    patterns.push(hub);
    for (let j = 0; j < 3; j += 1) {
      const dep = makePattern({
        id: `src/z_dep_${i}_${j}.tsx:ZDep${i}${j}:1` as PatternId,
        name: `ZDep${i}${j}`,
        filePath: `src/z_dep_${i}_${j}.tsx`,
      });
      patterns.push(dep);
      addRenderLink(dep, hub, patterns, edges);
    }
  }

  // Warning hubs (degree 2) — IDs sort second-to-last (y_)
  for (let i = 0; i < 5; i += 1) {
    const hub = makePattern({
      id: `src/y_warn_${i}.tsx:YWarn${i}:1` as PatternId,
      name: `YWarn${i}`,
      filePath: `src/y_warn_${i}.tsx`,
    });
    patterns.push(hub);
    for (let j = 0; j < 2; j += 1) {
      const dep = makePattern({
        id: `src/y_dep_${i}_${j}.tsx:YDep${i}${j}:1` as PatternId,
        name: `YDep${i}${j}`,
        filePath: `src/y_dep_${i}_${j}.tsx`,
      });
      patterns.push(dep);
      addRenderLink(dep, hub, patterns, edges);
    }
  }

  // Info hubs (degree 1) — IDs sort FIRST alphabetically (a_)
  // With sort-by-ID these fill all 50 slots; with severity sort they come after errors/warnings
  for (let i = 0; i < 50; i += 1) {
    const hub = makePattern({
      id: `src/a_info_${String(i).padStart(2, "0")}.tsx:AInfo${i}:1` as PatternId,
      name: `AInfo${i}`,
      filePath: `src/a_info_${String(i).padStart(2, "0")}.tsx`,
    });
    patterns.push(hub);
    const dep = makePattern({
      id: `src/a_dep_${String(i).padStart(2, "0")}.tsx:ADep${i}:1` as PatternId,
      name: `ADep${i}`,
      filePath: `src/a_dep_${String(i).padStart(2, "0")}.tsx`,
    });
    patterns.push(dep);
    addRenderLink(dep, hub, patterns, edges);
  }

  const result = new InsightEngine({
    hubInDegreeThreshold: 1,
    hubPercentileThreshold: 0,
    maxInsightsPerCategory: 50,
  }).generate(makeIndex(patterns, edges));

  const hubs = result.insights.filter((insight) => insight.category === "hub-component");
  assert(hubs.length === 50, `Hub insights should be limited to 50, got ${hubs.length}`);

  // Verify severity priority: errors must be retained even though their IDs sort last
  // applyCategoryLimit selects WHICH insights survive; generate() re-sorts by ID globally
  const errorHubs = hubs.filter((insight) => insight.severity === "error");
  const warningHubs = hubs.filter((insight) => insight.severity === "warning");
  const infoHubs = hubs.filter((insight) => insight.severity === "info");
  assert(errorHubs.length === 5, `All 5 error-severity hubs should be retained, got ${errorHubs.length}`);
  assert(warningHubs.length === 5, `All 5 warning-severity hubs should be retained, got ${warningHubs.length}`);
  assert(infoHubs.length === 40, `Only 40 info hubs should remain after limit, got ${infoHubs.length}`);

  console.log("PASS: testCategoryLimitSeverityPriority");
}

async function testEmptyIndex() {
  const result = new InsightEngine().generate(makeIndex([], []));
  assert(result.insights.length === 0, "Empty index should produce no insights");
  assert(result.stats.total === 0, "Empty index stats.total should be 0");

  console.log("PASS: testEmptyIndex");
}

async function testSingleComponentIndex() {
  const single = makePattern({
    id: "src/pages/Home.tsx:Home:1" as PatternId,
    name: "Home",
    filePath: "src/pages/Home.tsx",
    type: "page",
  });
  const result = new InsightEngine().generate(makeIndex([single], []));
  assert(result.insights.length === 0, "Single page component with no edges should produce no insights");

  console.log("PASS: testSingleComponentIndex");
}

async function testAllOrphans() {
  const a = makePattern({ id: "src/A.tsx:A:1" as PatternId, name: "A", filePath: "src/A.tsx" });
  const b = makePattern({ id: "src/B.tsx:B:1" as PatternId, name: "B", filePath: "src/B.tsx" });
  const c = makePattern({ id: "src/C.tsx:C:1" as PatternId, name: "C", filePath: "src/C.tsx" });

  const result = new InsightEngine().generate(makeIndex([a, b, c], []));
  const orphans = result.insights.filter((insight) => insight.category === "orphan-component");
  assert(orphans.length === 3, `Expected 3 orphan insights, got ${orphans.length}`);

  console.log("PASS: testAllOrphans");
}

async function testAbortSignal() {
  const patterns: PatternResult[] = [];
  const edges: DependencyEdge[] = [];

  for (let i = 0; i < 30; i += 1) {
    const hub = makePattern({
      id: `src/AbortHub${i}.tsx:AbortHub${i}:1` as PatternId,
      name: `AbortHub${i}`,
      filePath: `src/AbortHub${i}.tsx`,
    });
    const dep = makePattern({
      id: `src/AbortDep${i}.tsx:AbortDep${i}:1` as PatternId,
      name: `AbortDep${i}`,
      filePath: `src/AbortDep${i}.tsx`,
    });
    patterns.push(hub, dep);
    addRenderLink(dep, hub, patterns, edges);
  }

  let reads = 0;
  const signal = {
    get aborted(): boolean {
      reads += 1;
      return reads > 5;
    },
  } as AbortSignal;

  let thrown: unknown;
  try {
    new InsightEngine().generate(makeIndex(patterns, edges), { signal });
  } catch (err) {
    thrown = err;
  }

  assert(thrown instanceof Error, "Abort should throw an Error");
  assert(
    (thrown as Error).message.includes("aborted"),
    `Abort error message should include 'aborted', got: ${(thrown as Error).message}`,
  );

  console.log("PASS: testAbortSignal");
}

async function testDeterministicHash() {
  const hub = makePattern({
    id: "src/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/Button.tsx",
  });
  const dep = makePattern({
    id: "src/Home.tsx:Home:1" as PatternId,
    name: "Home",
    filePath: "src/Home.tsx",
  });

  const depPattern = makeDepPattern(dep, [hub.id], "render");

  const index = makeIndex(
    [hub, dep, depPattern],
    [{ from: depPattern.id, to: hub.id, kind: "render" }],
  );

  const engine = new InsightEngine();
  const result1 = engine.generate(index);
  const result2 = engine.generate(index);
  const insights1 = result1.insights;
  const insights2 = result2.insights;

  const hash1 = createHash("sha256").update(stableStringify(insights1)).digest("hex");
  const hash2 = createHash("sha256").update(stableStringify(insights2)).digest("hex");

  assert(hash1 === hash2, "Two runs with same input should produce identical insight hashes");
  assert(result1.hash === result2.hash, "InsightEngine result.hash should be deterministic");
  assert(result1.hash === hash1, "result.hash should match SHA-256(stableStringify(insights))");
  assert(result1.stats.total === insights1.length, "stats.total should match insights length");

  console.log("PASS: testDeterministicHash");
}

async function testIntegrationWithIntelligenceIndexer() {
  const root = await freshRoot();
  const indexer = new IntelligenceIndexer({ rootPath: root });

  const button = makePattern({
    id: "src/components/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/components/Button.tsx",
    type: "component",
  });
  const app = makePattern({
    id: "src/App.tsx:App:1" as PatternId,
    name: "App",
    filePath: "src/App.tsx",
    type: "component",
    dependencies: [],
  });
  const appDep = makeDepPattern(app, [button.id], "render");
  const profile = makePattern({
    id: ".:styling-profile:1" as PatternId,
    type: "utility",
    name: "styling-profile",
    filePath: ".",
    metadata: {
      primaryApproach: "tailwind",
      technologyTally: {
        tailwind: 2,
        emotion: 1,
      },
      totalStyleFiles: 1,
      totalStyledSourceFiles: 2,
    },
  });
  const styling = makePattern({
    id: "src/App.tsx:styling:1" as PatternId,
    type: "utility",
    name: "styling",
    filePath: "src/App.tsx",
    metadata: {
      tailwind: true,
      "inline-styles": true,
      emotion: false,
      "styled-components": false,
      "vanilla-extract": false,
      "css-modules": false,
    },
  });

  const outputs = new Map<string, AnalyzerOutput>([
    ["component", makeOutput("component", "1.0.0", [app, button])],
    ["dependency", makeOutput("dependency", "1.0.0", [appDep])],
    ["styling", makeOutput("styling", "1.0.0", [profile, styling])],
  ]);

  const index = await indexer.build(outputs);
  const engine = new InsightEngine();
  const result = engine.generate(index);
  const insights = result.insights;

  assert(insights.length > 0, "InsightEngine should produce insights from indexer output");
  assert(typeof result.hash === "string" && result.hash.length === 64, "result.hash should be 64-char hex");
  assert(result.durationMs >= 0, "durationMs should be non-negative");
  assert(result.stats.total === insights.length, "stats.total should match insights length");
  for (const insight of insights) {
    for (const id of insight.relatedPatterns) {
      assert(index.entries.has(id), `related pattern should exist in index: ${id as string}`);
    }
  }

  console.log("PASS: testIntegrationWithIntelligenceIndexer");
}

async function run() {
  try {
    await testHubComponentDetection();
    await testOrphanComponentDetection();
    await testDependencyCycleDetection();
    await testMixedStylingDetection();
    await testDeepDependencyChain3Hop();
    await testDeepDependencyChain10Hop();
    await testDeepDependencyChainWithCycle();
    await testDeepDependencyChainDeterministic();
    await testDeepDependencyChainMultipleRoots();
    await testDeepDependencyChainNoChains();
    await testGodComponentDetection();
    await testWrongDirectoryDetection();
    await testExcessivePropsDetection();
    await testInconsistentNamingDetection();
    await testMissingBarrelExposureDetection();
    await testCategoryLimitSeverityPriority();
    await testEmptyIndex();
    await testSingleComponentIndex();
    await testAllOrphans();
    await testAbortSignal();
    await testDeterministicHash();
    await testIntegrationWithIntelligenceIndexer();

    console.log("\nAll 22 tests passed.");
  } finally {
    await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
