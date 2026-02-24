import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResolverScorer } from "../../src/query/ResolverScorer.js";
import type { ScoredMatch } from "../../src/query/ResolverScorer.js";
import { InvertedIndex } from "../../src/query/InvertedIndex.js";
import type { SearchMatch } from "../../src/query/InvertedIndex.js";
import { QueryEngine } from "../../src/query/QueryEngine.js";
import { stableStringify } from "../../src/core/utils.js";
import type { PatternId, PatternResult } from "../../src/types/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testExactMatchScore() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      matchedTokens: ["button"],
      matchKinds: [{ token: "button", kind: "exact" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  assert(results.length === 1, "Should have 1 result");
  assert(results[0].score === 1.0, `Exact score should be 1.0, got ${results[0].score}`);
  assert(results[0].patternId === ("src/Button.tsx:Button:1" as PatternId), "PatternId should match");

  console.log("PASS: testExactMatchScore");
}

function testSynonymMatchScore() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Modal.tsx:Modal:1" as PatternId,
      matchedTokens: ["modal"],
      matchKinds: [{ token: "modal", kind: "synonym" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  assert(results.length === 1, "Should have 1 result");
  assert(results[0].score === 0.5, `Synonym score should be 0.5, got ${results[0].score}`);

  console.log("PASS: testSynonymMatchScore");
}

function testFuzzyMatchScore() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      matchedTokens: ["button"],
      matchKinds: [{ token: "button", kind: "fuzzy" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  assert(results.length === 1, "Should have 1 result");
  assert(results[0].score === 0.2, `Fuzzy score should be 0.2, got ${results[0].score}`);

  console.log("PASS: testFuzzyMatchScore");
}

function testMultipleTokensAccumulate() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/PrimaryButton.tsx:PrimaryButton:1" as PatternId,
      matchedTokens: ["button", "primary"],
      matchKinds: [
        { token: "button", kind: "exact" },
        { token: "primary", kind: "exact" },
      ],
    },
  ];

  const results = scorer.scoreMatches(matches);
  assert(results.length === 1, "Should have 1 result");
  assert(results[0].score === 2.0, `Two exact tokens should score 2.0, got ${results[0].score}`);

  console.log("PASS: testMultipleTokensAccumulate");
}

function testMixedMatchKindsAccumulate() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Modal.tsx:Modal:1" as PatternId,
      matchedTokens: ["dialog", "modal"],
      matchKinds: [
        { token: "dialog", kind: "fuzzy" },
        { token: "modal", kind: "synonym" },
      ],
    },
  ];

  const results = scorer.scoreMatches(matches);
  assert(results.length === 1, "Should have 1 result");
  // fuzzy(0.2) + synonym(0.5) = 0.7
  const expected = 0.7;
  assert(
    Math.abs(results[0].score - expected) < 0.001,
    `Mixed score should be ${expected}, got ${results[0].score}`,
  );

  console.log("PASS: testMixedMatchKindsAccumulate");
}

function testSortByScoreDescThenIdAsc() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Z.tsx:Z:1" as PatternId,
      matchedTokens: ["z"],
      matchKinds: [{ token: "z", kind: "exact" }],
    },
    {
      patternId: "src/A.tsx:A:1" as PatternId,
      matchedTokens: ["a", "extra"],
      matchKinds: [
        { token: "a", kind: "exact" },
        { token: "extra", kind: "exact" },
      ],
    },
    {
      patternId: "src/B.tsx:B:1" as PatternId,
      matchedTokens: ["b"],
      matchKinds: [{ token: "b", kind: "exact" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  assert(results.length === 3, "Should have 3 results");
  // A has score 2.0, B and Z have score 1.0 each
  assert(results[0].patternId === ("src/A.tsx:A:1" as PatternId), "Highest score first (A, 2.0)");
  assert(results[1].patternId === ("src/B.tsx:B:1" as PatternId), "Same score → patternId asc (B before Z)");
  assert(results[2].patternId === ("src/Z.tsx:Z:1" as PatternId), "Same score → patternId asc (Z last)");

  console.log("PASS: testSortByScoreDescThenIdAsc");
}

function testEmptyInput() {
  const scorer = new ResolverScorer();
  const results = scorer.scoreMatches([]);
  assert(results.length === 0, "Empty input should return empty output");

  console.log("PASS: testEmptyInput");
}

function testWeightConstants() {
  assert(ResolverScorer.EXACT_WEIGHT === 1.0, "EXACT_WEIGHT should be 1.0");
  assert(ResolverScorer.SYNONYM_WEIGHT === 0.5, "SYNONYM_WEIGHT should be 0.5");
  assert(ResolverScorer.FUZZY_WEIGHT === 0.2, "FUZZY_WEIGHT should be 0.2");

  console.log("PASS: testWeightConstants");
}

function testSearchMatchPreservation() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      matchedTokens: ["button"],
      matchKinds: [{ token: "button", kind: "exact" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  assert(results[0].matchedTokens.length === 1, "matchedTokens should be preserved");
  assert(results[0].matchedTokens[0] === "button", "matchedTokens[0] should be 'button'");
  assert(results[0].reasons.length === 1, "reasons should be preserved");
  assert(results[0].reasons[0].token === "button", "reasons token should match");
  assert(results[0].reasons[0].kind === "exact", "reasons kind should match");
  assert(results[0].reasons[0].weight === 1.0, "reasons weight should be 1.0 for exact");
  assert(typeof results[0].reasons[0].description === "string", "reasons description should be a string");

  console.log("PASS: testSearchMatchPreservation");
}

function testIntegrationSearchAndScore() {
  const button = makePattern({
    id: "src/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/Button.tsx",
  });
  const modal = makePattern({
    id: "src/Modal.tsx:Modal:1" as PatternId,
    name: "Modal",
    filePath: "src/Modal.tsx",
  });

  const idx = new InvertedIndex([button, modal]);
  const scorer = new ResolverScorer();

  // Exact search
  const exactMatches = idx.search("button");
  const exactScored = scorer.scoreMatches(exactMatches);
  assert(exactScored.length === 1, "Exact: should find 1 match");
  assert(exactScored[0].patternId === button.id, "Exact: should find Button");
  assert(exactScored[0].score === 1.0, "Exact: score should be 1.0");

  // Synonym search: dialog → modal
  const synMatches = idx.search("dialog", { synonyms: true });
  const synScored = scorer.scoreMatches(synMatches);
  assert(synScored.length === 1, "Synonym: should find 1 match");
  assert(synScored[0].patternId === modal.id, "Synonym: should find Modal");
  assert(synScored[0].score === 0.5, `Synonym: score should be 0.5, got ${synScored[0].score}`);

  // Fuzzy search: buttn → button
  const fuzzyMatches = idx.search("buttn", { fuzzy: true });
  const fuzzyScored = scorer.scoreMatches(fuzzyMatches);
  assert(fuzzyScored.length === 1, "Fuzzy: should find 1 match");
  assert(fuzzyScored[0].patternId === button.id, "Fuzzy: should find Button");
  assert(fuzzyScored[0].score === 0.2, `Fuzzy: score should be 0.2, got ${fuzzyScored[0].score}`);

  console.log("PASS: testIntegrationSearchAndScore");
}

function testDeterministicScoring() {
  const patterns = [
    makePattern({ id: "src/Z.tsx:Z:1" as PatternId, name: "Zebra", filePath: "src/Z.tsx" }),
    makePattern({ id: "src/A.tsx:A:1" as PatternId, name: "Alpha", filePath: "src/A.tsx" }),
  ];

  const idx1 = new InvertedIndex(patterns);
  const idx2 = new InvertedIndex([...patterns].reverse());
  const scorer = new ResolverScorer();

  const results1 = JSON.stringify(scorer.scoreMatches(idx1.search("alpha")));
  const results2 = JSON.stringify(scorer.scoreMatches(idx2.search("alpha")));
  assert(results1 === results2, "Scoring should be deterministic regardless of input order");

  console.log("PASS: testDeterministicScoring");
}

function testSearchMatchKindPriority() {
  // When a token matches via multiple routes, the best kind should win
  const modal = makePattern({
    id: "src/Modal.tsx:Modal:1" as PatternId,
    name: "Modal",
    filePath: "src/Modal.tsx",
  });

  const idx = new InvertedIndex([modal]);

  // "modal" searched directly with synonyms enabled
  // "modal" is both an exact base token AND a synonym key
  // It should be "exact" (highest priority)
  const results = idx.search("modal", { synonyms: true });
  assert(results.length === 1, "Should find 1 match");
  const modalMatch = results[0].matchKinds.find((m) => m.token === "modal");
  assert(modalMatch !== undefined, "Should have a modal token match");
  assert(modalMatch!.kind === "exact", `'modal' should be exact, got ${modalMatch!.kind}`);

  console.log("PASS: testSearchMatchKindPriority");
}

async function testQueryEngineResolveTaskScored() {
  const root = join(
    tmpdir(),
    "uiq-scorer-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
  );
  const uiqDir = join(root, ".uiq");
  await mkdir(uiqDir, { recursive: true });

  const button: PatternResult = makePattern({
    id: "src/components/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/components/Button.tsx",
  });
  const sidebar: PatternResult = makePattern({
    id: "src/layout/Sidebar.tsx:Sidebar:1" as PatternId,
    name: "Sidebar",
    filePath: "src/layout/Sidebar.tsx",
  });

  const indexJson = stableStringify({
    schemaVersion: 1,
    buildNumber: 1,
    compositeHash: "0".repeat(64),
    entries: {
      [button.id as string]: button,
      [sidebar.id as string]: sidebar,
    },
    edges: [],
    fileIndex: {
      [button.filePath]: [button.id],
      [sidebar.filePath]: [sidebar.id],
    },
    typeIndex: {
      component: [button.id, sidebar.id],
    },
    stats: {
      totalPatterns: 2,
      totalEdges: 0,
      totalFiles: 2,
      byFramework: { react: 2 },
      byType: { component: 2 },
    },
  });

  const insightsJson = stableStringify({
    version: "1.0.0",
    hash: "0".repeat(64),
    stats: { total: 0, byType: {} },
    insights: [],
  });

  await writeFile(join(uiqDir, "index.json"), indexJson, "utf-8");
  await writeFile(join(uiqDir, "insights.json"), insightsJson, "utf-8");

  try {
    const engine = new QueryEngine(root);
    await engine.load();

    // resolveTask returns ScoredMatch[] — with debug=true for full reasons
    const results = engine.resolveTask("button", { debug: true });
    assert(results.length === 1, `resolveTask should find 1, got ${results.length}`);
    assert(results[0].patternId === button.id, "Should find Button");
    assert(results[0].score === 1.0, `Score should be 1.0, got ${results[0].score}`);
    assert(results[0].matchedTokens.length > 0, "Should have matchedTokens");
    assert(results[0].reasons.length > 0, "Should have reasons when debug=true");

    // Without debug, reasons should be empty
    const noDebug = engine.resolveTask("button");
    assert(noDebug[0].reasons.length === 0, "Should have empty reasons when debug is not set");

    // Synonym: panel → sidebar
    const synResults = engine.resolveTask("panel", { synonyms: true, debug: true });
    assert(synResults.length === 1, "Synonym resolve should find 1");
    assert(synResults[0].patternId === sidebar.id, "Should find Sidebar");
    assert(synResults[0].score === 0.5, `Synonym score should be 0.5, got ${synResults[0].score}`);

    // Fuzzy: buttn → button
    const fuzzyResults = engine.resolveTask("buttn", { fuzzy: true, debug: true });
    assert(fuzzyResults.length === 1, "Fuzzy resolve should find 1");
    assert(fuzzyResults[0].patternId === button.id, "Should find Button");
    assert(fuzzyResults[0].score === 0.2, `Fuzzy score should be 0.2, got ${fuzzyResults[0].score}`);

    // Scoring order: higher score first
    const allResults = engine.resolveTask("button sidebar", { synonyms: true, debug: true });
    assert(allResults.length === 2, `Should find 2 patterns, got ${allResults.length}`);
    assert(allResults[0].score >= allResults[1].score, "Results should be sorted by score descending");

    console.log("PASS: testQueryEngineResolveTaskScored");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  testExactMatchScore();
  testSynonymMatchScore();
  testFuzzyMatchScore();
  testMultipleTokensAccumulate();
  testMixedMatchKindsAccumulate();
  testSortByScoreDescThenIdAsc();
  testEmptyInput();
  testWeightConstants();
  testSearchMatchPreservation();
  testIntegrationSearchAndScore();
  testDeterministicScoring();
  testSearchMatchKindPriority();
  await testQueryEngineResolveTaskScored();

  console.log("\nAll 13 ResolverScorer tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
