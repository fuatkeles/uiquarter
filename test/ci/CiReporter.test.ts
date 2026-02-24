import { strict as assert } from "node:assert";
import { generateCiReport, generateGithubActionTemplate } from "../../src/ci/CiReporter.js";
import type { DriftReport } from "../../src/drift/DriftDetector.js";

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

function makeMockDrift(overrides?: Partial<DriftReport>): DriftReport {
  return {
    hashChanged: true,
    buildBefore: 1,
    buildAfter: 2,
    generatedBefore: "2024-01-01T00:00:00Z",
    generatedAfter: "2024-01-02T00:00:00Z",
    stats: {
      before: { totalPatterns: 10, totalEdges: 5, totalFiles: 3, byFramework: {}, byType: {} },
      after: { totalPatterns: 12, totalEdges: 6, totalFiles: 4, byFramework: {}, byType: {} },
      patternDelta: 2,
      edgeDelta: 1,
      fileDelta: 1,
    },
    patterns: {
      added: ["new-pattern"],
      removed: [],
      total: { before: 10, after: 12 },
    },
    insights: {
      added: [],
      removed: [],
      total: { before: 5, after: 5 },
    },
    ...overrides,
  };
}

interface MockInsight {
  readonly id: string;
  readonly category: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
}

function makeInsight(
  id: string,
  severity: string = "info",
  category: string = "general",
  title: string = "Test insight",
): MockInsight {
  return { id, category, severity, title, description: "Details about " + title };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testNoRegressions(): Promise<void> {
  const drift = makeMockDrift({
    insights: { added: [], removed: [], total: { before: 5, after: 5 } },
  });
  const result = generateCiReport(drift, [], { format: "text", failOn: "error" });
  assert.equal(result.exitCode, 0, "should exit 0 with no new insights");
  assert.equal(result.newIssueCount, 0);
  ok("testNoRegressions");
}

async function testNewErrorInsight(): Promise<void> {
  const drift = makeMockDrift({
    insights: { added: ["error-insight-1"], removed: [], total: { before: 5, after: 6 } },
  });
  const insights = [makeInsight("error-insight-1", "error", "dependency-cycle", "Circular dep found")];
  const result = generateCiReport(drift, insights, { format: "text", failOn: "error" });
  assert.equal(result.exitCode, 1, "should fail with error insight");
  assert.equal(result.newIssueCount, 1);
  ok("testNewErrorInsight");
}

async function testNewWarningWithFailOnError(): Promise<void> {
  const drift = makeMockDrift({
    insights: { added: ["warn-insight-1"], removed: [], total: { before: 5, after: 6 } },
  });
  const insights = [makeInsight("warn-insight-1", "warning", "general", "Some warning")];
  const result = generateCiReport(drift, insights, { format: "text", failOn: "error" });
  assert.equal(result.exitCode, 0, "warning should not fail when failOn=error");
  ok("testNewWarningWithFailOnError");
}

async function testNewWarningWithFailOnWarning(): Promise<void> {
  const drift = makeMockDrift({
    insights: { added: ["warn-insight-1"], removed: [], total: { before: 5, after: 6 } },
  });
  const insights = [makeInsight("warn-insight-1", "warning", "general", "Some warning")];
  const result = generateCiReport(drift, insights, { format: "text", failOn: "warning" });
  assert.equal(result.exitCode, 1, "warning should fail when failOn=warning");
  ok("testNewWarningWithFailOnWarning");
}

async function testMarkdownFormat(): Promise<void> {
  const drift = makeMockDrift();
  const result = generateCiReport(drift, [], { format: "md", failOn: "error" });
  assert.ok(result.output.includes("##"), "markdown should contain ## headings");
  assert.ok(result.output.includes("UIQuarter CI Report"), "should contain report title");
  ok("testMarkdownFormat");
}

async function testJsonFormat(): Promise<void> {
  const drift = makeMockDrift();
  const result = generateCiReport(drift, [], { format: "json", failOn: "error" });
  const parsed = JSON.parse(result.output);
  assert.ok(parsed.status !== undefined, "JSON should have status field");
  assert.equal(parsed.status, "PASS");
  ok("testJsonFormat");
}

async function testTextFormat(): Promise<void> {
  const drift = makeMockDrift();
  const result = generateCiReport(drift, [], { format: "text", failOn: "error" });
  assert.ok(result.output.includes("UIQuarter CI Report"), "should contain title");
  assert.ok(result.output.includes("Status: PASS"), "should contain status");
  assert.ok(!result.output.includes("##"), "text format should not contain ## headings");
  ok("testTextFormat");
}

async function testNullDrift(): Promise<void> {
  const insights = [makeInsight("existing-1", "warning", "general", "Existing issue")];
  const result = generateCiReport(null, insights, { format: "text", failOn: "error" });
  assert.equal(result.exitCode, 0, "null drift should always pass");
  assert.equal(result.newIssueCount, 0);
  ok("testNullDrift");
}

async function testResolvedIssues(): Promise<void> {
  const drift = makeMockDrift({
    insights: {
      added: [],
      removed: ["old-insight-1"],
      total: { before: 6, after: 5 },
    },
  });
  const result = generateCiReport(drift, [], { format: "text", failOn: "error" });
  assert.equal(result.resolvedIssueCount, 1, "should report 1 resolved issue");
  assert.ok(result.output.includes("Resolved"), "should mention resolved issues");
  ok("testResolvedIssues");
}

async function testGithubActionTemplate(): Promise<void> {
  const template = generateGithubActionTemplate();
  assert.ok(template.includes("name:"), "should contain YAML name field");
  assert.ok(template.includes("runs-on:"), "should contain runs-on field");
  assert.ok(template.includes("uiquarter"), "should reference uiquarter");
  assert.ok(template.includes("pull_request"), "should trigger on pull_request");
  ok("testGithubActionTemplate");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("CiReporter Tests");
  await testNoRegressions();
  await testNewErrorInsight();
  await testNewWarningWithFailOnError();
  await testNewWarningWithFailOnWarning();
  await testMarkdownFormat();
  await testJsonFormat();
  await testTextFormat();
  await testNullDrift();
  await testResolvedIssues();
  await testGithubActionTemplate();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
