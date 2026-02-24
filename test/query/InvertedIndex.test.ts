import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InvertedIndex } from "../../src/query/InvertedIndex.js";
import type { SearchMatch } from "../../src/query/InvertedIndex.js";
import { QueryEngine } from "../../src/query/QueryEngine.js";
import { stableStringify } from "../../src/core/utils.js";
import type { PatternId, PatternResult } from "../../src/types/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertArrayEqual(actual: readonly string[], expected: readonly string[], msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg}\n  actual:   ${a}\n  expected: ${e}`);
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

function testTokenExtractionFromName() {
  const pattern = makePattern({
    id: "src/UserModalDialog.tsx:UserModalDialog:1" as PatternId,
    name: "UserModalDialog",
    filePath: "src/UserModalDialog.tsx",
  });

  const idx = new InvertedIndex([pattern]);
  const tokens = idx.getTokensForPattern(pattern.id);

  assert(tokens.includes("user"), "Should extract 'user' from camelCase name");
  assert(tokens.includes("modal"), "Should extract 'modal' from camelCase name");
  assert(tokens.includes("dialog"), "Should extract 'dialog' from camelCase name");
  assert(!tokens.includes("component"), "Should exclude stop word 'component'");
  assert(!tokens.includes("src"), "Should exclude stop word 'src'");

  console.log("PASS: testTokenExtractionFromName");
}

function testTokenExtractionFromFilePath() {
  const pattern = makePattern({
    id: "src/features/auth/LoginForm.tsx:LoginForm:1" as PatternId,
    name: "LoginForm",
    filePath: "src/features/auth/LoginForm.tsx",
  });

  const idx = new InvertedIndex([pattern]);
  const tokens = idx.getTokensForPattern(pattern.id);

  assert(tokens.includes("features"), "Should extract 'features' from path");
  assert(tokens.includes("auth"), "Should extract 'auth' from path");
  assert(tokens.includes("login"), "Should extract 'login' from path");
  assert(tokens.includes("form"), "Should extract 'form' from path");

  console.log("PASS: testTokenExtractionFromFilePath");
}

function testTokenExtractionFromMetadata() {
  const pattern = makePattern({
    id: "src/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/Button.tsx",
    metadata: {
      role: "primary-action",
      variant: "outlined",
      count: 42, // non-string — should be skipped as value
    },
  });

  const idx = new InvertedIndex([pattern]);
  const tokens = idx.getTokensForPattern(pattern.id);

  assert(tokens.includes("role"), "Should extract metadata key 'role'");
  assert(tokens.includes("primary"), "Should extract 'primary' from metadata value 'primary-action'");
  assert(tokens.includes("action"), "Should extract 'action' from metadata value 'primary-action'");
  assert(tokens.includes("variant"), "Should extract metadata key 'variant'");
  assert(tokens.includes("outlined"), "Should extract metadata value 'outlined'");

  console.log("PASS: testTokenExtractionFromMetadata");
}

function testStopWordExclusion() {
  const pattern = makePattern({
    id: "src/index.tsx:TheComponent:1" as PatternId,
    name: "TheComponent",
    filePath: "src/index.tsx",
  });

  const idx = new InvertedIndex([pattern]);
  const tokens = idx.getTokensForPattern(pattern.id);

  assert(!tokens.includes("the"), "Should exclude stop word 'the'");
  assert(!tokens.includes("component"), "Should exclude stop word 'component'");
  assert(!tokens.includes("src"), "Should exclude stop word 'src'");
  assert(!tokens.includes("index"), "Should exclude stop word 'index'");

  console.log("PASS: testStopWordExclusion");
}

function testExactSearch() {
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

  const buttonResults = idx.search("button");
  assert(buttonResults.length === 1, `Expected 1 result for 'button', got ${buttonResults.length}`);
  assert(buttonResults[0].patternId === button.id, "Should find Button pattern");
  assert(buttonResults[0].matchKinds[0].kind === "exact", "Should be an exact match");

  const modalResults = idx.search("modal");
  assert(modalResults.length === 1, `Expected 1 result for 'modal', got ${modalResults.length}`);
  assert(modalResults[0].patternId === modal.id, "Should find Modal pattern");

  console.log("PASS: testExactSearch");
}

function testFuzzySearch() {
  const button = makePattern({
    id: "src/Button.tsx:Button:1" as PatternId,
    name: "Button",
    filePath: "src/Button.tsx",
  });

  const idx = new InvertedIndex([button]);

  // "buttn" is edit distance 1 from "button"
  const noFuzzy = idx.search("buttn");
  assert(noFuzzy.length === 0, "Without fuzzy, 'buttn' should not match");

  const fuzzy = idx.search("buttn", { fuzzy: true });
  assert(fuzzy.length === 1, `Expected 1 fuzzy result for 'buttn', got ${fuzzy.length}`);
  assert(fuzzy[0].patternId === button.id, "Fuzzy should find Button");
  assert(fuzzy[0].matchKinds.some((m) => m.kind === "fuzzy"), "Should contain a fuzzy match kind");

  console.log("PASS: testFuzzySearch");
}

function testSynonymExpansion() {
  const modal = makePattern({
    id: "src/Modal.tsx:Modal:1" as PatternId,
    name: "Modal",
    filePath: "src/Modal.tsx",
  });

  const idx = new InvertedIndex([modal]);

  const noSynonym = idx.search("dialog");
  assert(noSynonym.length === 0, "Without synonyms, 'dialog' should not match Modal");

  const withSynonym = idx.search("dialog", { synonyms: true });
  assert(withSynonym.length === 1, `Expected 1 synonym result for 'dialog', got ${withSynonym.length}`);
  assert(withSynonym[0].patternId === modal.id, "Synonym expansion should find Modal via 'dialog'");
  assert(withSynonym[0].matchKinds.some((m) => m.kind === "synonym"), "Should contain a synonym match kind");

  console.log("PASS: testSynonymExpansion");
}

function testSynonymSidebar() {
  const sidebar = makePattern({
    id: "src/Sidebar.tsx:Sidebar:1" as PatternId,
    name: "Sidebar",
    filePath: "src/Sidebar.tsx",
  });

  const idx = new InvertedIndex([sidebar]);

  const results = idx.search("panel", { synonyms: true });
  assert(results.length === 1, "Synonym 'panel' should match Sidebar");
  assert(results[0].patternId === sidebar.id, "Should find Sidebar via synonym");

  console.log("PASS: testSynonymSidebar");
}

function testGetPatternsForToken() {
  const a = makePattern({
    id: "src/A.tsx:A:1" as PatternId,
    name: "UserForm",
    filePath: "src/A.tsx",
  });
  const b = makePattern({
    id: "src/B.tsx:B:1" as PatternId,
    name: "UserProfile",
    filePath: "src/B.tsx",
  });

  const idx = new InvertedIndex([a, b]);

  const userPatterns = idx.getPatternsForToken("user");
  assert(userPatterns.length === 2, `Expected 2 patterns for 'user', got ${userPatterns.length}`);

  // Verify deterministic sort
  assert(
    (userPatterns[0] as string) < (userPatterns[1] as string),
    "Results should be sorted by PatternId",
  );

  console.log("PASS: testGetPatternsForToken");
}

function testGetPatternsForTokens() {
  const a = makePattern({
    id: "src/A.tsx:A:1" as PatternId,
    name: "Button",
    filePath: "src/A.tsx",
  });
  const b = makePattern({
    id: "src/B.tsx:B:1" as PatternId,
    name: "Modal",
    filePath: "src/B.tsx",
  });
  const c = makePattern({
    id: "src/C.tsx:C:1" as PatternId,
    name: "Card",
    filePath: "src/C.tsx",
  });

  const idx = new InvertedIndex([a, b, c]);

  const results = idx.getPatternsForTokens(["button", "modal"]);
  assert(results.length === 2, `Expected 2 patterns, got ${results.length}`);
  assert(results.includes(a.id), "Should include Button");
  assert(results.includes(b.id), "Should include Modal");

  console.log("PASS: testGetPatternsForTokens");
}

function testGetAllTokens() {
  const pattern = makePattern({
    id: "src/UserCard.tsx:UserCard:1" as PatternId,
    name: "UserCard",
    filePath: "src/UserCard.tsx",
  });

  const idx = new InvertedIndex([pattern]);
  const allTokens = idx.getAllTokens();

  assert(allTokens.length > 0, "Should have tokens");
  // Verify sorted
  for (let i = 1; i < allTokens.length; i++) {
    assert(allTokens[i - 1]! <= allTokens[i]!, "getAllTokens should be sorted");
  }

  console.log("PASS: testGetAllTokens");
}

function testUnknownPatternThrows() {
  const idx = new InvertedIndex([]);
  let thrown = false;
  try {
    idx.getTokensForPattern("nonexistent:id:1" as PatternId);
  } catch (err) {
    thrown = true;
    assert(
      (err as Error).message.includes("not indexed"),
      `Error message should contain 'not indexed', got: ${(err as Error).message}`,
    );
  }
  assert(thrown, "getTokensForPattern should throw for unknown pattern");

  console.log("PASS: testUnknownPatternThrows");
}

function testDeterministicOutput() {
  const patterns = [
    makePattern({ id: "src/Z.tsx:Z:1" as PatternId, name: "Zebra", filePath: "src/Z.tsx" }),
    makePattern({ id: "src/A.tsx:A:1" as PatternId, name: "Alpha", filePath: "src/A.tsx" }),
    makePattern({ id: "src/M.tsx:M:1" as PatternId, name: "Middle", filePath: "src/M.tsx" }),
  ];

  const idx1 = new InvertedIndex(patterns);
  const idx2 = new InvertedIndex([...patterns].reverse());

  const tokens1 = JSON.stringify(idx1.getAllTokens());
  const tokens2 = JSON.stringify(idx2.getAllTokens());
  assert(tokens1 === tokens2, "Token list should be deterministic regardless of input order");

  const search1 = JSON.stringify(idx1.search("alpha").map((m) => m.patternId));
  const search2 = JSON.stringify(idx2.search("alpha").map((m) => m.patternId));
  assert(search1 === search2, "Search results should be deterministic regardless of input order");

  console.log("PASS: testDeterministicOutput");
}

function testEmptyIndex() {
  const idx = new InvertedIndex([]);
  assert(idx.getAllTokens().length === 0, "Empty index should have no tokens");
  assert(idx.search("anything").length === 0, "Empty index search should return nothing");
  assert(idx.getPatternsForToken("x").length === 0, "Empty index token lookup should return nothing");

  console.log("PASS: testEmptyIndex");
}

function testMultiWordSearch() {
  const button = makePattern({
    id: "src/PrimaryButton.tsx:PrimaryButton:1" as PatternId,
    name: "PrimaryButton",
    filePath: "src/PrimaryButton.tsx",
  });

  const idx = new InvertedIndex([button]);

  const results = idx.search("PrimaryButton");
  assert(results.length === 1, "Multi-word camelCase search should match");
  assert(results[0].patternId === button.id, "Should find PrimaryButton");

  console.log("PASS: testMultiWordSearch");
}

function testFuzzyAndSynonymCombined() {
  const modal = makePattern({
    id: "src/Modal.tsx:Modal:1" as PatternId,
    name: "Modal",
    filePath: "src/Modal.tsx",
  });

  const idx = new InvertedIndex([modal]);

  // "dialg" is edit distance 1 from "dialog", which is synonym of "modal"
  const results = idx.search("dialg", { fuzzy: true, synonyms: true });
  assert(results.length === 1, `Fuzzy + synonym should find Modal, got ${results.length}`);
  assert(results[0].patternId === modal.id, "Should find Modal via fuzzy+synonym chain");

  console.log("PASS: testFuzzyAndSynonymCombined");
}

async function testQueryEngineResolveTask() {
  const root = join(
    tmpdir(),
    "uiq-inverted-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
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

    // Exact match — resolveTask now returns ScoredMatch[]
    const buttonResults = engine.resolveTask("button");
    assert(buttonResults.length === 1, `resolveTask('button') should find 1, got ${buttonResults.length}`);
    assert(buttonResults[0].patternId === button.id, "resolveTask should find Button");
    assert(buttonResults[0].score === 1.0, "Exact match should score 1.0");

    // Synonym: panel → sidebar
    const panelResults = engine.resolveTask("panel", { synonyms: true });
    assert(panelResults.length === 1, `resolveTask('panel', synonyms) should find 1, got ${panelResults.length}`);
    assert(panelResults[0].patternId === sidebar.id, "resolveTask with synonym should find Sidebar");
    assert(panelResults[0].score === 0.5, "Synonym match should score 0.5");

    // Fuzzy: "buttn" → button (edit distance 1)
    const fuzzyResults = engine.resolveTask("buttn", { fuzzy: true });
    assert(fuzzyResults.length === 1, `resolveTask('buttn', fuzzy) should find 1, got ${fuzzyResults.length}`);
    assert(fuzzyResults[0].patternId === button.id, "resolveTask with fuzzy should find Button");
    assert(fuzzyResults[0].score > 0, "Fuzzy match should have positive score");

    // Token-based methods
    const tokenResults = engine.findPatternsByToken("button");
    assert(tokenResults.length === 1, "findPatternsByToken should find Button");

    const tokensResults = engine.findPatternsByTokens(["button", "sidebar"]);
    assert(tokensResults.length === 2, "findPatternsByTokens should find both");

    console.log("PASS: testQueryEngineResolveTask");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  testTokenExtractionFromName();
  testTokenExtractionFromFilePath();
  testTokenExtractionFromMetadata();
  testStopWordExclusion();
  testExactSearch();
  testFuzzySearch();
  testSynonymExpansion();
  testSynonymSidebar();
  testGetPatternsForToken();
  testGetPatternsForTokens();
  testGetAllTokens();
  testUnknownPatternThrows();
  testDeterministicOutput();
  testEmptyIndex();
  testMultiWordSearch();
  testFuzzyAndSynonymCombined();
  await testQueryEngineResolveTask();

  console.log("\nAll 17 InvertedIndex tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
