import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResolverScorer } from "../../src/query/ResolverScorer.js";
import type { MatchDetail, ScoredMatch } from "../../src/query/ResolverScorer.js";
import { InvertedIndex } from "../../src/query/InvertedIndex.js";
import type { SearchMatch } from "../../src/query/InvertedIndex.js";
import { QueryEngine } from "../../src/query/QueryEngine.js";
import { stableStringify } from "../../src/core/utils.js";
import { formatText, formatMarkdown, formatJson } from "../../src/cli/resolve.js";
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
// Helpers
// ---------------------------------------------------------------------------

async function createTempUiq(): Promise<{ root: string; button: PatternResult; sidebar: PatternResult }> {
  const root = join(
    tmpdir(),
    "uiq-debug-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
  );
  const uiqDir = join(root, ".uiq");
  await mkdir(uiqDir, { recursive: true });

  const button = makePattern({
    id: "src/components/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/components/Button.tsx",
  });
  const sidebar = makePattern({
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

  return { root, button, sidebar };
}

// ---------------------------------------------------------------------------
// Tests: MatchDetail structure
// ---------------------------------------------------------------------------

function testMatchDetailExact() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      matchedTokens: ["button"],
      matchKinds: [{ token: "button", kind: "exact" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  const reason = results[0].reasons[0];

  assert(reason.token === "button", "token should be 'button'");
  assert(reason.kind === "exact", "kind should be 'exact'");
  assert(reason.weight === 1.0, `weight should be 1.0, got ${reason.weight}`);
  assert(
    reason.description === 'Exact token match on "button" (+1.0)',
    `description mismatch: ${reason.description}`,
  );

  console.log("PASS: testMatchDetailExact");
}

function testMatchDetailSynonym() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Modal.tsx:Modal:1" as PatternId,
      matchedTokens: ["modal"],
      matchKinds: [{ token: "modal", kind: "synonym" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  const reason = results[0].reasons[0];

  assert(reason.token === "modal", "token should be 'modal'");
  assert(reason.kind === "synonym", "kind should be 'synonym'");
  assert(reason.weight === 0.5, `weight should be 0.5, got ${reason.weight}`);
  assert(
    reason.description === 'Synonym expansion match on "modal" (+0.5)',
    `description mismatch: ${reason.description}`,
  );

  console.log("PASS: testMatchDetailSynonym");
}

function testMatchDetailFuzzy() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      matchedTokens: ["button"],
      matchKinds: [{ token: "button", kind: "fuzzy" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  const reason = results[0].reasons[0];

  assert(reason.token === "button", "token should be 'button'");
  assert(reason.kind === "fuzzy", "kind should be 'fuzzy'");
  assert(reason.weight === 0.2, `weight should be 0.2, got ${reason.weight}`);
  assert(
    reason.description === 'Fuzzy match (edit distance ≤ 1) on "button" (+0.2)',
    `description mismatch: ${reason.description}`,
  );

  console.log("PASS: testMatchDetailFuzzy");
}

function testMatchDetailMixed() {
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
  assert(results[0].reasons.length === 2, "Should have 2 reasons");

  const fuzzyReason = results[0].reasons.find((r) => r.kind === "fuzzy")!;
  const synReason = results[0].reasons.find((r) => r.kind === "synonym")!;

  assert(fuzzyReason.weight === 0.2, "Fuzzy weight should be 0.2");
  assert(synReason.weight === 0.5, "Synonym weight should be 0.5");
  assert(
    Math.abs(results[0].score - 0.7) < 0.001,
    `Mixed score should be 0.7, got ${results[0].score}`,
  );

  console.log("PASS: testMatchDetailMixed");
}

function testMatchDetailAllFieldsPresent() {
  const scorer = new ResolverScorer();
  const matches: SearchMatch[] = [
    {
      patternId: "src/X.tsx:X:1" as PatternId,
      matchedTokens: ["alpha"],
      matchKinds: [{ token: "alpha", kind: "exact" }],
    },
  ];

  const results = scorer.scoreMatches(matches);
  const reason: MatchDetail = results[0].reasons[0];

  assert("token" in reason, "MatchDetail should have 'token'");
  assert("kind" in reason, "MatchDetail should have 'kind'");
  assert("weight" in reason, "MatchDetail should have 'weight'");
  assert("description" in reason, "MatchDetail should have 'description'");
  assert(typeof reason.token === "string", "token should be string");
  assert(typeof reason.kind === "string", "kind should be string");
  assert(typeof reason.weight === "number", "weight should be number");
  assert(typeof reason.description === "string", "description should be string");

  console.log("PASS: testMatchDetailAllFieldsPresent");
}

// ---------------------------------------------------------------------------
// Tests: QueryEngine debug flag
// ---------------------------------------------------------------------------

async function testDebugTrueReturnsReasons() {
  const { root } = await createTempUiq();
  try {
    const engine = new QueryEngine(root);
    await engine.load();

    const results = engine.resolveTask("button", { debug: true });
    assert(results.length === 1, "Should find 1 match");
    assert(results[0].reasons.length > 0, "debug=true should return populated reasons");
    assert(results[0].reasons[0].token === "button", "Reason token should be 'button'");
    assert(results[0].reasons[0].kind === "exact", "Reason kind should be 'exact'");
    assert(results[0].reasons[0].weight === 1.0, "Reason weight should be 1.0");

    console.log("PASS: testDebugTrueReturnsReasons");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testDebugFalseReturnsEmptyReasons() {
  const { root } = await createTempUiq();
  try {
    const engine = new QueryEngine(root);
    await engine.load();

    const results = engine.resolveTask("button", { debug: false });
    assert(results.length === 1, "Should find 1 match");
    assert(results[0].reasons.length === 0, "debug=false should return empty reasons");
    assert(results[0].score === 1.0, "Score should still be computed correctly");
    assert(results[0].matchedTokens.length > 0, "matchedTokens should still be present");

    console.log("PASS: testDebugFalseReturnsEmptyReasons");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testDebugDefaultReturnsEmptyReasons() {
  const { root } = await createTempUiq();
  try {
    const engine = new QueryEngine(root);
    await engine.load();

    // No debug option at all
    const results = engine.resolveTask("button");
    assert(results[0].reasons.length === 0, "Default (no debug) should return empty reasons");

    // Explicit empty options
    const results2 = engine.resolveTask("button", {});
    assert(results2[0].reasons.length === 0, "Empty options should return empty reasons");

    console.log("PASS: testDebugDefaultReturnsEmptyReasons");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tests: Text format output
// ---------------------------------------------------------------------------

function testTextFormatWithDebug() {
  const results: ScoredMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      score: 1.0,
      matchedTokens: ["button"],
      reasons: [
        {
          token: "button",
          kind: "exact",
          weight: 1.0,
          description: 'Exact token match on "button" (+1.0)',
        },
      ],
    },
  ];

  const output = formatText("add button", results, true);

  assert(output.includes("Resolve: \"add button\""), "Should include task in header");
  assert(output.includes("1 match(es)"), "Should include match count");
  assert(output.includes("src/Button.tsx:Button:1"), "Should include patternId");
  assert(output.includes("score: 1.00"), "Should include score");
  assert(output.includes("button [exact] +1.0"), "Should include debug token detail");
  assert(output.includes('Exact token match on "button" (+1.0)'), "Should include description");

  console.log("PASS: testTextFormatWithDebug");
}

function testTextFormatWithoutDebug() {
  const results: ScoredMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      score: 1.0,
      matchedTokens: ["button"],
      reasons: [],
    },
  ];

  const output = formatText("add button", results, false);

  assert(output.includes("src/Button.tsx:Button:1"), "Should include patternId");
  assert(output.includes("score: 1.00"), "Should include score");
  assert(!output.includes("[exact]"), "Should NOT include debug token detail");
  assert(!output.includes("Exact token match"), "Should NOT include description");

  console.log("PASS: testTextFormatWithoutDebug");
}

// ---------------------------------------------------------------------------
// Tests: Markdown format output
// ---------------------------------------------------------------------------

function testMdFormatWithDebug() {
  const results: ScoredMatch[] = [
    {
      patternId: "src/Modal.tsx:Modal:1" as PatternId,
      score: 0.5,
      matchedTokens: ["modal"],
      reasons: [
        {
          token: "modal",
          kind: "synonym",
          weight: 0.5,
          description: 'Synonym expansion match on "modal" (+0.5)',
        },
      ],
    },
  ];

  const output = formatMarkdown("show dialog", results, true);

  assert(output.includes("# Resolve: \"show dialog\""), "Should include markdown heading");
  assert(output.includes("1 matching pattern(s)"), "Should include match count");
  assert(output.includes("**src/Modal.tsx:Modal:1**"), "Should include bold patternId");
  assert(output.includes("score: 0.50"), "Should include score");
  assert(output.includes("`modal` (synonym, +0.5)"), "Should include debug token detail");
  assert(output.includes("Synonym expansion match"), "Should include description");

  console.log("PASS: testMdFormatWithDebug");
}

function testMdFormatWithoutDebug() {
  const results: ScoredMatch[] = [
    {
      patternId: "src/Modal.tsx:Modal:1" as PatternId,
      score: 0.5,
      matchedTokens: ["modal"],
      reasons: [],
    },
  ];

  const output = formatMarkdown("show dialog", results, false);

  assert(output.includes("**src/Modal.tsx:Modal:1**"), "Should include bold patternId");
  assert(!output.includes("`modal`"), "Should NOT include debug token detail");
  assert(!output.includes("Synonym expansion match"), "Should NOT include description");

  console.log("PASS: testMdFormatWithoutDebug");
}

// ---------------------------------------------------------------------------
// Tests: JSON format output
// ---------------------------------------------------------------------------

function testJsonFormatWithDebug() {
  const results: ScoredMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      score: 1.2,
      matchedTokens: ["button", "primary"],
      reasons: [
        {
          token: "button",
          kind: "exact",
          weight: 1.0,
          description: 'Exact token match on "button" (+1.0)',
        },
        {
          token: "primary",
          kind: "fuzzy",
          weight: 0.2,
          description: 'Fuzzy match (edit distance ≤ 1) on "primary" (+0.2)',
        },
      ],
    },
  ];

  const output = formatJson(results, true);
  const parsed = JSON.parse(output) as { patternId: string; score: number; reasons: MatchDetail[] }[];

  assert(parsed.length === 1, "Should have 1 result");
  assert("reasons" in parsed[0], "JSON with debug should include 'reasons' key");
  assert(Array.isArray(parsed[0].reasons), "reasons should be an array");
  assert(parsed[0].reasons.length === 2, "Should have 2 reasons");
  assert(parsed[0].reasons[0].token === "button", "First reason token should be 'button'");
  assert(parsed[0].reasons[0].weight === 1.0, "First reason weight should be 1.0");
  assert(parsed[0].reasons[1].kind === "fuzzy", "Second reason kind should be 'fuzzy'");

  console.log("PASS: testJsonFormatWithDebug");
}

function testJsonFormatWithoutDebug() {
  const results: ScoredMatch[] = [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      score: 1.0,
      matchedTokens: ["button"],
      reasons: [],
    },
  ];

  const output = formatJson(results, false);
  const parsed = JSON.parse(output) as Record<string, unknown>[];

  assert(parsed.length === 1, "Should have 1 result");
  assert("patternId" in parsed[0], "Should include patternId");
  assert("score" in parsed[0], "Should include score");
  assert("matchedTokens" in parsed[0], "Should include matchedTokens");
  assert(!("reasons" in parsed[0]), "JSON without debug should NOT include 'reasons' key");

  console.log("PASS: testJsonFormatWithoutDebug");
}

// ---------------------------------------------------------------------------
// Tests: Determinism
// ---------------------------------------------------------------------------

function testDebugOutputDeterminism() {
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
        { token: "extra", kind: "synonym" },
      ],
    },
  ];

  const run1 = JSON.stringify(scorer.scoreMatches(matches));
  const run2 = JSON.stringify(scorer.scoreMatches(matches));
  assert(run1 === run2, "Scoring with reasons should be deterministic");

  // Format determinism
  const results = scorer.scoreMatches(matches) as ScoredMatch[];
  const text1 = formatText("test", results, true);
  const text2 = formatText("test", results, true);
  assert(text1 === text2, "Text format with debug should be deterministic");

  const md1 = formatMarkdown("test", results, true);
  const md2 = formatMarkdown("test", results, true);
  assert(md1 === md2, "Markdown format with debug should be deterministic");

  const json1 = formatJson(results, true);
  const json2 = formatJson(results, true);
  assert(json1 === json2, "JSON format with debug should be deterministic");

  console.log("PASS: testDebugOutputDeterminism");
}

// ---------------------------------------------------------------------------
// Tests: Integration (InvertedIndex → ResolverScorer → format)
// ---------------------------------------------------------------------------

function testIntegrationExactDebugPipeline() {
  const button = makePattern({
    id: "src/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/Button.tsx",
  });

  const idx = new InvertedIndex([button]);
  const scorer = new ResolverScorer();

  const searchResults = idx.search("button");
  const scored = scorer.scoreMatches(searchResults);

  assert(scored.length === 1, "Should find 1 match");
  assert(scored[0].reasons.length > 0, "Should have reasons from scorer");
  assert(scored[0].reasons[0].kind === "exact", "Should be exact match");
  assert(scored[0].reasons[0].weight === 1.0, "Weight should be 1.0");

  // Verify text format includes debug info
  const text = formatText("button", scored, true);
  assert(text.includes("[exact] +1.0"), "Text should include debug breakdown");

  // Verify json format includes reasons
  const json = formatJson(scored, true);
  const parsed = JSON.parse(json) as { reasons: MatchDetail[] }[];
  assert(parsed[0].reasons.length > 0, "JSON should include reasons");

  console.log("PASS: testIntegrationExactDebugPipeline");
}

function testIntegrationSynonymDebugPipeline() {
  const modal = makePattern({
    id: "src/Modal.tsx:Modal:1" as PatternId,
    name: "Modal",
    filePath: "src/Modal.tsx",
  });

  const idx = new InvertedIndex([modal]);
  const scorer = new ResolverScorer();

  const searchResults = idx.search("dialog", { synonyms: true });
  const scored = scorer.scoreMatches(searchResults);

  assert(scored.length === 1, "Should find 1 match via synonym");
  const synReason = scored[0].reasons.find((r) => r.kind === "synonym");
  assert(synReason !== undefined, "Should have a synonym reason");
  assert(synReason!.weight === 0.5, "Synonym weight should be 0.5");

  // Verify md format includes debug info
  const md = formatMarkdown("dialog", scored, true);
  assert(md.includes("(synonym, +0.5)"), "Markdown should include synonym detail");

  console.log("PASS: testIntegrationSynonymDebugPipeline");
}

function testIntegrationFuzzyDebugPipeline() {
  const button = makePattern({
    id: "src/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/Button.tsx",
  });

  const idx = new InvertedIndex([button]);
  const scorer = new ResolverScorer();

  const searchResults = idx.search("buttn", { fuzzy: true });
  const scored = scorer.scoreMatches(searchResults);

  assert(scored.length === 1, "Should find 1 match via fuzzy");
  const fuzzyReason = scored[0].reasons.find((r) => r.kind === "fuzzy");
  assert(fuzzyReason !== undefined, "Should have a fuzzy reason");
  assert(fuzzyReason!.weight === 0.2, "Fuzzy weight should be 0.2");
  assert(
    fuzzyReason!.description.includes("Fuzzy match"),
    "Description should mention fuzzy match",
  );

  console.log("PASS: testIntegrationFuzzyDebugPipeline");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  // MatchDetail structure tests
  testMatchDetailExact();
  testMatchDetailSynonym();
  testMatchDetailFuzzy();
  testMatchDetailMixed();
  testMatchDetailAllFieldsPresent();

  // QueryEngine debug flag tests
  await testDebugTrueReturnsReasons();
  await testDebugFalseReturnsEmptyReasons();
  await testDebugDefaultReturnsEmptyReasons();

  // Text format tests
  testTextFormatWithDebug();
  testTextFormatWithoutDebug();

  // Markdown format tests
  testMdFormatWithDebug();
  testMdFormatWithoutDebug();

  // JSON format tests
  testJsonFormatWithDebug();
  testJsonFormatWithoutDebug();

  // Determinism
  testDebugOutputDeterminism();

  // Integration pipeline tests
  testIntegrationExactDebugPipeline();
  testIntegrationSynonymDebugPipeline();
  testIntegrationFuzzyDebugPipeline();

  console.log("\nAll 18 ResolverScoringDebug tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
