import {
  normalizeOutput,
  DEFAULT_METADATA_KEY_MAP,
} from "../src/core/normalizer.js";
import type {
  AnalyzerOutput,
  AnalyzerDiagnostic,
  PatternResult,
  ConfidenceScore,
  PatternProperty,
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

function makeConfidence(overrides?: Partial<ConfidenceScore>): ConfidenceScore {
  return {
    value: 0.8,
    source: "test",
    factors: [
      { name: "naming", weight: 0.5, score: 0.9 },
      { name: "ast", weight: 0.5, score: 0.7 },
    ],
    ...overrides,
  };
}

function makePattern(overrides?: Partial<PatternResult>): PatternResult {
  return {
    id: "pat-1" as PatternId,
    type: "component",
    name: "Button",
    filePath: "src/Button.tsx",
    location: { start: { line: 1, column: 0 }, end: { line: 10, column: 1 } },
    confidence: makeConfidence(),
    framework: "react",
    dependencies: [],
    properties: {},
    metadata: {},
    ...overrides,
  };
}

function makeDiagnostic(overrides?: Partial<AnalyzerDiagnostic>): AnalyzerDiagnostic {
  return {
    severity: "warning",
    filePath: "src/App.tsx",
    message: "Unused import",
    line: 5,
    column: 1,
    ...overrides,
  };
}

function makeOutput(overrides?: Partial<AnalyzerOutput>): AnalyzerOutput {
  return {
    analyzerId: "test@1.0.0" as AnalyzerId,
    patterns: [makePattern()],
    diagnostics: [makeDiagnostic()],
    hash: "original-hash" as OutputHash,
    duration: 100,
    stats: { totalFiles: 10, analyzedFiles: 8, cacheHits: 2, cacheMisses: 8 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testBasicNormalization() {
  const output = makeOutput();
  const result = normalizeOutput(output);

  // Should return a new object
  assert(result !== output, "Should return new object, not mutate input");

  // Should preserve analyzerId, duration, stats
  assert(result.analyzerId === output.analyzerId, "analyzerId should be preserved");
  assert(result.duration === output.duration, "duration should be preserved");
  assertDeepEqual(result.stats, output.stats, "stats should be preserved");

  // Hash should be recomputed (different from input)
  assert(result.hash !== "original-hash", "Hash should be recomputed");
  assert(typeof result.hash === "string" && result.hash.length === 64, "Hash should be 64-char hex");

  console.log("PASS: testBasicNormalization");
}

function testPatternsSortedById() {
  const output = makeOutput({
    patterns: [
      makePattern({ id: "z-pattern" as PatternId, name: "Z" }),
      makePattern({ id: "a-pattern" as PatternId, name: "A" }),
      makePattern({ id: "m-pattern" as PatternId, name: "M" }),
    ],
  });

  const result = normalizeOutput(output);

  assert(result.patterns[0]!.id === ("a-pattern" as PatternId), `First should be a-pattern, got ${result.patterns[0]!.id}`);
  assert(result.patterns[1]!.id === ("m-pattern" as PatternId), `Second should be m-pattern, got ${result.patterns[1]!.id}`);
  assert(result.patterns[2]!.id === ("z-pattern" as PatternId), `Third should be z-pattern, got ${result.patterns[2]!.id}`);

  console.log("PASS: testPatternsSortedById");
}

function testDiagnosticsSorted() {
  const output = makeOutput({
    diagnostics: [
      makeDiagnostic({ filePath: "z.ts", line: 1, column: 1, severity: "error", message: "b" }),
      makeDiagnostic({ filePath: "a.ts", line: 1, column: 1, severity: "warning", message: "a" }),
      makeDiagnostic({ filePath: "a.ts", line: 1, column: 1, severity: "error", message: "a" }),
      makeDiagnostic({ filePath: "a.ts", line: 2, column: 1, severity: "info", message: "c" }),
    ],
  });

  const result = normalizeOutput(output);

  // Sort order: filePath → line → column → severity → message
  assert(result.diagnostics[0]!.filePath === "a.ts", "First by filePath");
  assert(result.diagnostics[0]!.severity === "error", "Then by severity (error < warning)");
  assert(result.diagnostics[1]!.severity === "warning", "warning comes after error");
  assert(result.diagnostics[2]!.line === 2, "Line 2 comes after line 1");
  assert(result.diagnostics[3]!.filePath === "z.ts", "z.ts comes last");

  console.log("PASS: testDiagnosticsSorted");
}

function testDependenciesSortedAndDeduped() {
  const output = makeOutput({
    patterns: [
      makePattern({
        dependencies: [
          "dep-c" as PatternId,
          "dep-a" as PatternId,
          "dep-b" as PatternId,
          "dep-a" as PatternId, // duplicate
        ],
      }),
    ],
  });

  const result = normalizeOutput(output);
  const deps = result.patterns[0]!.dependencies;

  assert(deps.length === 3, `Should have 3 unique deps, got ${deps.length}`);
  assert(deps[0] === ("dep-a" as PatternId), "First dep should be dep-a");
  assert(deps[1] === ("dep-b" as PatternId), "Second dep should be dep-b");
  assert(deps[2] === ("dep-c" as PatternId), "Third dep should be dep-c");

  console.log("PASS: testDependenciesSortedAndDeduped");
}

function testConfidenceClamping() {
  const output = makeOutput({
    patterns: [
      makePattern({
        confidence: {
          value: 1.5, // over max
          source: "test",
          factors: [
            { name: "a", weight: -0.3, score: 2.0 }, // both out of range
          ],
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const conf = result.patterns[0]!.confidence;

  assert(conf.value === 1, `Confidence value should be clamped to 1, got ${conf.value}`);
  assert(conf.factors[0]!.weight === 0, `Weight should be clamped to 0, got ${conf.factors[0]!.weight}`);
  assert(conf.factors[0]!.score === 1, `Score should be clamped to 1, got ${conf.factors[0]!.score}`);

  console.log("PASS: testConfidenceClamping");
}

function testConfidenceFactorsSortedByName() {
  const output = makeOutput({
    patterns: [
      makePattern({
        confidence: {
          value: 0.5,
          source: "test",
          factors: [
            { name: "z-factor", weight: 0.3, score: 0.5 },
            { name: "a-factor", weight: 0.4, score: 0.6 },
            { name: "m-factor", weight: 0.3, score: 0.4 },
          ],
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const names = result.patterns[0]!.confidence.factors.map((f) => f.name);

  assertDeepEqual(names, ["a-factor", "m-factor", "z-factor"], "Factors should be sorted by name");

  console.log("PASS: testConfidenceFactorsSortedByName");
}

function testFrameworkLowercaseTrimmed() {
  const output = makeOutput({
    patterns: [
      makePattern({ framework: "  React  " }),
    ],
  });

  const result = normalizeOutput(output);
  assert(result.patterns[0]!.framework === "react", `Framework should be 'react', got '${result.patterns[0]!.framework}'`);

  console.log("PASS: testFrameworkLowercaseTrimmed");
}

function testPatternNameTrimmed() {
  const output = makeOutput({
    patterns: [
      makePattern({ name: "  Button  " }),
    ],
  });

  const result = normalizeOutput(output);
  assert(result.patterns[0]!.name === "Button", `Name should be trimmed, got '${result.patterns[0]!.name}'`);

  console.log("PASS: testPatternNameTrimmed");
}

function testFilePathForwardSlashes() {
  const output = makeOutput({
    patterns: [
      makePattern({ filePath: "src\\components\\Button.tsx" }),
    ],
  });

  const result = normalizeOutput(output);
  assert(
    result.patterns[0]!.filePath === "src/components/Button.tsx",
    `Path should use forward slashes, got '${result.patterns[0]!.filePath}'`,
  );

  console.log("PASS: testFilePathForwardSlashes");
}

function testMetadataBooleanToCategory() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          tailwind: true,
          redux: true,
          "react-router": true,
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const meta = result.patterns[0]!.metadata;

  assert(meta["styling"] === "tailwind", `styling should be 'tailwind', got '${meta["styling"]}'`);
  assert(meta["stateManagement"] === "redux", `stateManagement should be 'redux', got '${meta["stateManagement"]}'`);
  assert(meta["routing"] === "react-router", `routing should be 'react-router', got '${meta["routing"]}'`);

  console.log("PASS: testMetadataBooleanToCategory");
}

function testMetadataFalseDropped() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          tailwind: false,
          redux: false,
          keepThis: "value",
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const meta = result.patterns[0]!.metadata;

  assert(!("tailwind" in meta), "false booleans should be dropped");
  assert(!("redux" in meta), "false booleans should be dropped");
  assert(!("styling" in meta), "false → no category mapping");
  assert(meta["keepThis"] === "value", "Non-boolean values should be kept");

  console.log("PASS: testMetadataFalseDropped");
}

function testMetadataUnmappedBooleanToFlags() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          responsive: true,
          animated: true,
          dark: true,
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const meta = result.patterns[0]!.metadata;

  assert(Array.isArray(meta["flags"]), `flags should be an array, got ${typeof meta["flags"]}`);
  const flags = meta["flags"] as string[];
  assertDeepEqual(flags, ["animated", "dark", "responsive"], "Flags should be sorted");

  console.log("PASS: testMetadataUnmappedBooleanToFlags");
}

function testMetadataMixedBooleanAndNonBoolean() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          tailwind: true,
          responsive: true,
          variant: "primary",
          ssr: false,
          count: 42,
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const meta = result.patterns[0]!.metadata;

  assert(meta["styling"] === "tailwind", "Mapped boolean → category");
  assert((meta["flags"] as string[]).includes("responsive"), "Unmapped boolean → flags");
  assert(meta["variant"] === "primary", "String kept as-is");
  assert(meta["count"] === 42, "Number kept as-is");
  assert(!("ssr" in meta), "false boolean dropped");

  console.log("PASS: testMetadataMixedBooleanAndNonBoolean");
}

function testMetadataCategoryConflict() {
  // Both tailwind and scss map to category "styling"
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          tailwind: true,
          scss: true,
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const meta = result.patterns[0]!.metadata;

  // First one wins for the category, second goes to flags
  assert(meta["styling"] !== undefined, "Should have a styling category");
  // The conflict key goes to flags
  assert(Array.isArray(meta["flags"]), "Conflict should produce a flags entry");

  console.log("PASS: testMetadataCategoryConflict");
}

function testMetadataKeysSorted() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          z_key: "z",
          a_key: "a",
          m_key: "m",
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const keys = Object.keys(result.patterns[0]!.metadata);

  assertDeepEqual(keys, ["a_key", "m_key", "z_key"], "Metadata keys should be sorted");

  console.log("PASS: testMetadataKeysSorted");
}

function testPropertiesSorted() {
  const props: Record<string, PatternProperty> = {
    z_prop: { name: "z_prop", type: "string", required: false },
    a_prop: { name: " a_prop ", type: " number ", required: true, defaultValue: "0" },
    m_prop: { name: "m_prop", type: "boolean", required: true },
  };

  const output = makeOutput({
    patterns: [makePattern({ properties: props })],
  });

  const result = normalizeOutput(output);
  const resultProps = result.patterns[0]!.properties;
  const propKeys = Object.keys(resultProps);

  assertDeepEqual(propKeys, ["a_prop", "m_prop", "z_prop"], "Property keys should be sorted");

  // Properties name/type should be trimmed
  assert(resultProps["a_prop"]!.name === "a_prop", `Name should be trimmed, got '${resultProps["a_prop"]!.name}'`);
  assert(resultProps["a_prop"]!.type === "number", `Type should be trimmed, got '${resultProps["a_prop"]!.type}'`);

  // defaultValue should be preserved
  assert(resultProps["a_prop"]!.defaultValue === "0", "defaultValue should be preserved");

  // No defaultValue → key should not exist
  assert(!("defaultValue" in resultProps["m_prop"]!), "defaultValue should not be added if not present");

  console.log("PASS: testPropertiesSorted");
}

function testHashDeterminism() {
  const output = makeOutput({
    patterns: [
      makePattern({ id: "b" as PatternId, name: "B" }),
      makePattern({ id: "a" as PatternId, name: "A" }),
    ],
  });

  // Normalize twice with same input — should get same hash
  const r1 = normalizeOutput(output);
  const r2 = normalizeOutput(output);

  assert(r1.hash === r2.hash, "Same input should produce same hash");

  // Reverse pattern order in input — after normalization, hash should still be the same
  const outputReversed = makeOutput({
    patterns: [
      makePattern({ id: "a" as PatternId, name: "A" }),
      makePattern({ id: "b" as PatternId, name: "B" }),
    ],
  });

  const r3 = normalizeOutput(outputReversed);
  assert(r1.hash === r3.hash, "Different input order should produce same hash after normalization");

  console.log("PASS: testHashDeterminism");
}

function testHashChangesWithContent() {
  const output1 = makeOutput({
    patterns: [makePattern({ name: "Button" })],
  });

  const output2 = makeOutput({
    patterns: [makePattern({ name: "Card" })],
  });

  const r1 = normalizeOutput(output1);
  const r2 = normalizeOutput(output2);

  assert(r1.hash !== r2.hash, "Different content should produce different hash");

  console.log("PASS: testHashChangesWithContent");
}

function testCustomMetadataKeyMap() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          mylib: true,
          tailwind: true, // should NOT be mapped with custom empty map
        },
      }),
    ],
  });

  // Empty key map = structural-only mode, all booleans go to flags
  const result = normalizeOutput(output, { metadataKeyMap: {} });
  const meta = result.patterns[0]!.metadata;

  assert(!("styling" in meta), "Empty key map should not produce categories");
  const flags = meta["flags"] as string[];
  assert(flags.includes("mylib"), "mylib should be in flags");
  assert(flags.includes("tailwind"), "tailwind should be in flags (no mapping)");

  console.log("PASS: testCustomMetadataKeyMap");
}

function testCustomMetadataKeyMapWithEntries() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          mylib: true,
        },
      }),
    ],
  });

  const result = normalizeOutput(output, {
    metadataKeyMap: {
      mylib: { category: "custom", value: "my-library" },
    },
  });

  const meta = result.patterns[0]!.metadata;
  assert(meta["custom"] === "my-library", `custom category should be 'my-library', got '${meta["custom"]}'`);

  console.log("PASS: testCustomMetadataKeyMapWithEntries");
}

function testPureFunction() {
  const original = makeOutput({
    patterns: [
      makePattern({
        name: "  Button  ",
        framework: "  React  ",
        filePath: "src\\Button.tsx",
        metadata: { tailwind: true, responsive: true },
      }),
    ],
  });

  // Deep clone to compare later
  const beforeJson = JSON.stringify(original);

  normalizeOutput(original);

  const afterJson = JSON.stringify(original);
  assert(beforeJson === afterJson, "normalizeOutput should not mutate input");

  console.log("PASS: testPureFunction");
}

function testEmptyOutput() {
  const output = makeOutput({
    patterns: [],
    diagnostics: [],
  });

  const result = normalizeOutput(output);

  assert(result.patterns.length === 0, "Should handle empty patterns");
  assert(result.diagnostics.length === 0, "Should handle empty diagnostics");
  assert(typeof result.hash === "string" && result.hash.length === 64, "Hash should still be computed");

  console.log("PASS: testEmptyOutput");
}

function testConfidenceSourceTrimmed() {
  const output = makeOutput({
    patterns: [
      makePattern({
        confidence: {
          value: 0.5,
          source: "  naming-convention  ",
          factors: [{ name: "  some factor  ", weight: 0.5, score: 0.5 }],
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const conf = result.patterns[0]!.confidence;

  assert(conf.source === "naming-convention", `Source should be trimmed, got '${conf.source}'`);
  assert(conf.factors[0]!.name === "some factor", `Factor name should be trimmed, got '${conf.factors[0]!.name}'`);

  console.log("PASS: testConfidenceSourceTrimmed");
}

function testDefaultMetadataKeyMapCoverage() {
  // Verify key categories are present
  const categories = new Set(Object.values(DEFAULT_METADATA_KEY_MAP).map((m) => m.category));

  assert(categories.has("styling"), "Should have styling category");
  assert(categories.has("stateManagement"), "Should have stateManagement category");
  assert(categories.has("routing"), "Should have routing category");
  assert(categories.has("dataFetching"), "Should have dataFetching category");
  assert(categories.has("formLibrary"), "Should have formLibrary category");
  assert(categories.has("testing"), "Should have testing category");

  // Verify specific mappings
  assert(DEFAULT_METADATA_KEY_MAP["tailwind"]!.category === "styling", "tailwind → styling");
  assert(DEFAULT_METADATA_KEY_MAP["redux"]!.category === "stateManagement", "redux → stateManagement");
  assert(DEFAULT_METADATA_KEY_MAP["vitest"]!.category === "testing", "vitest → testing");

  console.log("PASS: testDefaultMetadataKeyMapCoverage");
}

function testDiagnosticsWithoutLineColumn() {
  const output = makeOutput({
    diagnostics: [
      { severity: "warning", filePath: "a.ts", message: "msg" },
      { severity: "error", filePath: "a.ts", message: "msg2", line: 5 },
      { severity: "info", filePath: "a.ts", message: "msg3" },
    ],
  });

  const result = normalizeOutput(output);

  // Diagnostics without line/column should sort (line defaults to 0, column defaults to 0)
  assert(result.diagnostics.length === 3, "All diagnostics preserved");
  // No-line entries (line=0) come before line=5
  assert(result.diagnostics[2]!.line === 5, "Line 5 should come last");

  console.log("PASS: testDiagnosticsWithoutLineColumn");
}

function testMetadataKeyMapCaseInsensitive() {
  const output = makeOutput({
    patterns: [
      makePattern({
        metadata: {
          Tailwind: true, // uppercase T
          REDUX: true,    // all caps
        },
      }),
    ],
  });

  const result = normalizeOutput(output);
  const meta = result.patterns[0]!.metadata;

  assert(meta["styling"] === "tailwind", `Tailwind (uppercase) should still map to styling`);
  assert(meta["stateManagement"] === "redux", `REDUX (caps) should still map to stateManagement`);

  console.log("PASS: testMetadataKeyMapCaseInsensitive");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  testBasicNormalization();
  testPatternsSortedById();
  testDiagnosticsSorted();
  testDependenciesSortedAndDeduped();
  testConfidenceClamping();
  testConfidenceFactorsSortedByName();
  testFrameworkLowercaseTrimmed();
  testPatternNameTrimmed();
  testFilePathForwardSlashes();
  testMetadataBooleanToCategory();
  testMetadataFalseDropped();
  testMetadataUnmappedBooleanToFlags();
  testMetadataMixedBooleanAndNonBoolean();
  testMetadataCategoryConflict();
  testMetadataKeysSorted();
  testPropertiesSorted();
  testHashDeterminism();
  testHashChangesWithContent();
  testCustomMetadataKeyMap();
  testCustomMetadataKeyMapWithEntries();
  testPureFunction();
  testEmptyOutput();
  testConfidenceSourceTrimmed();
  testDefaultMetadataKeyMapCoverage();
  testDiagnosticsWithoutLineColumn();
  testMetadataKeyMapCaseInsensitive();

  console.log("\nAll 26 tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
