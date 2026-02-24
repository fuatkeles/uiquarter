import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  ConventionChecker,
  formatViolationsText,
  formatViolationsMarkdown,
  formatViolationsJson,
} from "../../src/conventions/ConventionChecker.js";
import type { IntelligenceIndex } from "../../src/types/index.js";
import type { Insight } from "../../src/types/index.js";

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

function makeEmptyIndex(): IntelligenceIndex {
  return {
    schemaVersion: 1,
    buildNumber: 1,
    compositeHash: "abc",
    entries: {},
    edges: [],
    fileIndex: {},
    typeIndex: {},
    stats: { totalPatterns: 0, totalEdges: 0, totalFiles: 0, byFramework: {}, byType: {} },
  } as unknown as IntelligenceIndex;
}

function makeIndexWithPatterns(
  patterns: Array<{
    id: string;
    type: string;
    name: string;
    filePath: string;
    metadata?: Record<string, unknown>;
  }>,
): IntelligenceIndex {
  const entries: Record<string, unknown> = {};
  const fileIndex: Record<string, string[]> = {};
  const typeIndex: Record<string, string[]> = {};

  for (const p of patterns) {
    const fullPattern = {
      id: p.id,
      type: p.type,
      name: p.name,
      filePath: p.filePath,
      location: { file: p.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: { value: 0.9, source: "test", factors: [] },
      framework: "react",
      dependencies: [],
      properties: {},
      metadata: p.metadata ?? {},
    };
    entries[p.id] = fullPattern;

    if (!fileIndex[p.filePath]) fileIndex[p.filePath] = [];
    fileIndex[p.filePath]!.push(p.id);

    if (!typeIndex[p.type]) typeIndex[p.type] = [];
    typeIndex[p.type]!.push(p.id);
  }

  return {
    schemaVersion: 1,
    buildNumber: 1,
    compositeHash: "abc",
    entries,
    edges: [],
    fileIndex,
    typeIndex,
    stats: {
      totalPatterns: patterns.length,
      totalEdges: 0,
      totalFiles: Object.keys(fileIndex).length,
      byFramework: {},
      byType: {},
    },
  } as unknown as IntelligenceIndex;
}

function makeInsight(
  category: string,
  title: string,
  severity: string = "warning",
): Insight {
  return {
    id: `insight-${category}-${Date.now()}`,
    category,
    severity,
    confidence: 0.9,
    title,
    description: "Details about " + title,
    relatedPatterns: [],
    metadata: {},
  } as unknown as Insight;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testNoViolations(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-conv-"));
  try {
    const checker = new ConventionChecker(tmp);
    const index = makeIndexWithPatterns([
      { id: "p1", type: "component", name: "Button", filePath: "src/Button.tsx" },
      { id: "p2", type: "component", name: "Modal", filePath: "src/Modal.tsx" },
    ]);
    const result = await checker.check(index, []);
    assert.equal(result.violations.length, 0, "should have 0 violations for clean project");
    ok("testNoViolations");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testCircularDepViolation(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-conv-"));
  try {
    const checker = new ConventionChecker(tmp);
    const index = makeEmptyIndex();
    const insights = [
      makeInsight("dependency-cycle", "Circular dependency detected between A and B", "error"),
    ];
    const result = await checker.check(index, insights);
    const circularViolations = result.violations.filter(v => v.ruleId === "circular-deps");
    assert.ok(circularViolations.length > 0, "should detect circular dependency violation");
    ok("testCircularDepViolation");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testMixedStylingViolation(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-conv-"));
  try {
    const checker = new ConventionChecker(tmp);
    const index = makeEmptyIndex();
    const insights = [
      makeInsight("mixed-styling", "Project uses both CSS Modules and styled-components"),
    ];
    const result = await checker.check(index, insights);
    const stylingViolations = result.violations.filter(v => v.ruleId === "single-styling");
    assert.ok(stylingViolations.length > 0, "should detect mixed styling violation");
    ok("testMixedStylingViolation");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testBarrelMissing(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-conv-"));
  try {
    const checker = new ConventionChecker(tmp);
    const index = makeIndexWithPatterns([
      { id: "p1", type: "component", name: "Button", filePath: "src/components/Button.tsx" },
      { id: "p2", type: "component", name: "Modal", filePath: "src/components/Modal.tsx" },
      { id: "p3", type: "component", name: "Card", filePath: "src/components/Card.tsx" },
    ]);
    const result = await checker.check(index, []);
    const barrelViolations = result.violations.filter(v => v.ruleId === "barrel-exports");
    assert.ok(barrelViolations.length > 0, "should detect missing barrel export");
    ok("testBarrelMissing");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testFormatText(): Promise<void> {
  const result = {
    violations: [],
    rulesChecked: 5,
    filesChecked: 10,
  };
  const text = formatViolationsText(result);
  assert.ok(text.includes("Convention Check Results"), "should contain title");
  assert.ok(text.includes("Rules checked: 5"), "should contain rules count");
  assert.ok(typeof text === "string", "should return a string");
  ok("testFormatText");
}

async function testFormatMarkdown(): Promise<void> {
  const result = {
    violations: [
      {
        ruleId: "circular-deps",
        severity: "error" as const,
        filePath: "",
        message: "Circular dep found",
      },
    ],
    rulesChecked: 5,
    filesChecked: 10,
  };
  const md = formatViolationsMarkdown(result);
  assert.ok(md.includes("##"), "should contain ## headers");
  assert.ok(md.includes("Convention Check Results") || md.includes("# Convention"), "should contain title");
  ok("testFormatMarkdown");
}

async function testFormatJson(): Promise<void> {
  const result = {
    violations: [],
    rulesChecked: 5,
    filesChecked: 10,
  };
  const jsonStr = formatViolationsJson(result);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.rulesChecked, 5);
  assert.equal(parsed.filesChecked, 10);
  assert.equal(parsed.totalViolations, 0);
  ok("testFormatJson");
}

async function testEmptyProject(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-conv-"));
  try {
    const checker = new ConventionChecker(tmp);
    const index = makeEmptyIndex();
    const result = await checker.check(index, []);
    assert.equal(result.violations.length, 0, "should have 0 violations for empty project");
    ok("testEmptyProject");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testCustomConfig(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-conv-"));
  try {
    // Write a .uiqrc.json that disables circular-deps rule
    await writeFile(
      join(tmp, ".uiqrc.json"),
      JSON.stringify({
        rules: {
          "circular-deps": { enabled: false },
        },
      }),
    );
    const checker = new ConventionChecker(tmp);
    const index = makeEmptyIndex();
    const insights = [
      makeInsight("dependency-cycle", "Circular dependency detected"),
    ];
    const result = await checker.check(index, insights);
    const circularViolations = result.violations.filter(v => v.ruleId === "circular-deps");
    assert.equal(circularViolations.length, 0, "should not report circular deps when rule is disabled");
    ok("testCustomConfig");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testDeterministicOutput(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-conv-"));
  try {
    const checker = new ConventionChecker(tmp);
    const index = makeIndexWithPatterns([
      { id: "p1", type: "component", name: "Button", filePath: "src/Button.tsx" },
    ]);
    const insights = [
      makeInsight("dependency-cycle", "Circular dep A -> B"),
    ];
    const r1 = await checker.check(index, insights);
    const r2 = await checker.check(index, insights);
    assert.equal(r1.violations.length, r2.violations.length, "should produce same number of violations");
    assert.equal(r1.rulesChecked, r2.rulesChecked, "should check same number of rules");
    if (r1.violations.length > 0) {
      assert.equal(r1.violations[0]!.ruleId, r2.violations[0]!.ruleId, "same violation order");
    }
    ok("testDeterministicOutput");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("ConventionChecker Tests");
  await testNoViolations();
  await testCircularDepViolation();
  await testMixedStylingViolation();
  await testBarrelMissing();
  await testFormatText();
  await testFormatMarkdown();
  await testFormatJson();
  await testEmptyProject();
  await testCustomConfig();
  await testDeterministicOutput();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
