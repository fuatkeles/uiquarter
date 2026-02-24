import { strict as assert } from "node:assert";
import { generateHtmlReport } from "../../src/report/HtmlReporter.js";
import type { ProjectContext } from "../../src/context/ContextBuilder.js";

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

function makeMockContext(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    summary: { totalComponents: 5, totalInsights: 3, hubCount: 1, deepChainCount: 0 },
    components: [
      { name: "Button", filePath: "src/Button.tsx", dependencyCount: 0, dependentCount: 3, isHub: true, isOrphan: false },
      { name: "Modal", filePath: "src/Modal.tsx", dependencyCount: 1, dependentCount: 1, isHub: false, isOrphan: false },
    ],
    insights: [
      { type: "hub-component", severity: "info", confidence: 0.9, component: "Button", message: "Button is a hub" },
    ],
    deepChains: [],
    hubs: [{ component: "Button", dependentCount: 3, confidence: 0.9 }],
    ...overrides,
  };
}

function makeEmptyContext(): ProjectContext {
  return {
    summary: { totalComponents: 0, totalInsights: 0, hubCount: 0, deepChainCount: 0 },
    components: [],
    insights: [],
    deepChains: [],
    hubs: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testHtmlStructure(): Promise<void> {
  const html = generateHtmlReport({
    project: makeMockContext(),
    generatedAt: "2024-01-15T10:00:00Z",
  });
  assert.ok(html.startsWith("<!DOCTYPE html>"), "should start with <!DOCTYPE html>");
  assert.ok(html.includes("<html"), "should contain <html> tag");
  assert.ok(html.includes("</html>"), "should contain closing </html> tag");
  assert.ok(html.includes("<head>"), "should contain <head>");
  assert.ok(html.includes("<body>"), "should contain <body>");
  ok("testHtmlStructure");
}

async function testSummaryCards(): Promise<void> {
  const html = generateHtmlReport({
    project: makeMockContext(),
    generatedAt: "2024-01-15T10:00:00Z",
  });
  assert.ok(html.includes("Components"), "should contain 'Components' label");
  assert.ok(html.includes("5"), "should contain component count");
  assert.ok(html.includes("Insights"), "should contain 'Insights' label");
  assert.ok(html.includes("Hub Components"), "should contain 'Hub Components' label");
  ok("testSummaryCards");
}

async function testMermaidGraph(): Promise<void> {
  const html = generateHtmlReport({
    project: makeMockContext(),
    generatedAt: "2024-01-15T10:00:00Z",
  });
  assert.ok(html.includes("mermaid"), "should contain mermaid reference");
  assert.ok(
    html.includes("graph TD") || html.includes("class=\"mermaid\""),
    "should contain mermaid graph definition or class"
  );
  ok("testMermaidGraph");
}

async function testComponentTable(): Promise<void> {
  const html = generateHtmlReport({
    project: makeMockContext(),
    generatedAt: "2024-01-15T10:00:00Z",
  });
  assert.ok(html.includes("Name"), "should contain 'Name' header");
  assert.ok(html.includes("File"), "should contain 'File' header");
  assert.ok(html.includes("Deps"), "should contain 'Deps' header");
  assert.ok(html.includes("Dependents"), "should contain 'Dependents' header");
  assert.ok(html.includes("Button"), "should contain component name 'Button'");
  assert.ok(html.includes("Modal"), "should contain component name 'Modal'");
  ok("testComponentTable");
}

async function testInsightsSection(): Promise<void> {
  const html = generateHtmlReport({
    project: makeMockContext(),
    generatedAt: "2024-01-15T10:00:00Z",
  });
  assert.ok(html.includes("insight-info") || html.includes("severity-info"), "should contain insight severity classes");
  assert.ok(html.includes("hub-component"), "should contain insight type");
  ok("testInsightsSection");
}

async function testEmptyProject(): Promise<void> {
  const html = generateHtmlReport({
    project: makeEmptyContext(),
    generatedAt: "2024-01-15T10:00:00Z",
  });
  assert.ok(html.startsWith("<!DOCTYPE html>"), "should still produce valid HTML");
  assert.ok(html.includes("0"), "should show 0 counts");
  assert.ok(html.includes("No components found") || html.includes("Components"), "should handle empty state");
  ok("testEmptyProject");
}

async function testUxCoverage(): Promise<void> {
  const html = generateHtmlReport({
    project: makeMockContext(),
    generatedAt: "2024-01-15T10:00:00Z",
    uxCoverage: {
      accessibility: 0.75,
      errorState: 0.6,
      loadingState: 0.8,
      responsive: 0.9,
    },
  });
  assert.ok(html.includes("UX Coverage"), "should contain UX Coverage section");
  assert.ok(html.includes("Accessibility"), "should contain Accessibility label");
  assert.ok(html.includes("coverage-bar") || html.includes("coverage-fill"), "should contain coverage bars");
  assert.ok(html.includes("75%"), "should show accessibility percentage");
  ok("testUxCoverage");
}

async function testDeterministic(): Promise<void> {
  const data = {
    project: makeMockContext(),
    generatedAt: "2024-01-15T10:00:00Z",
  };
  const html1 = generateHtmlReport(data);
  const html2 = generateHtmlReport(data);
  assert.equal(html1, html2, "two calls with same data should produce identical output");
  ok("testDeterministic");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("HtmlReporter Tests");
  await testHtmlStructure();
  await testSummaryCards();
  await testMermaidGraph();
  await testComponentTable();
  await testInsightsSection();
  await testEmptyProject();
  await testUxCoverage();
  await testDeterministic();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
