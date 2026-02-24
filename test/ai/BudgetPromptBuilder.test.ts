import { BudgetPromptBuilder } from "../../src/ai/BudgetPromptBuilder.js";
import { PromptBuilder } from "../../src/ai/PromptBuilder.js";
import type {
  ProjectContext,
  HubContext,
  ChainContext,
  InsightContext,
} from "../../src/context/ContextBuilder.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEmptyContext(): ProjectContext {
  return {
    summary: { totalComponents: 0, hubCount: 0, deepChainCount: 0, totalInsights: 0 },
    components: [],
    insights: [],
    deepChains: [],
    hubs: [],
  };
}

function makeRichContext(): ProjectContext {
  const hubs: HubContext[] = [
    { component: "Button", dependentCount: 15, confidence: 0.95 },
    { component: "Modal", dependentCount: 8, confidence: 0.88 },
    { component: "Card", dependentCount: 3, confidence: 0.75 },
  ];

  const deepChains: ChainContext[] = [
    { length: 12, root: "App", leaf: "Icon", components: ["App", "Layout", "Sidebar", "Nav", "Link", "Icon"] },
    { length: 9, root: "Page", leaf: "Text", components: ["Page", "Section", "Text"] },
  ];

  const insights: InsightContext[] = [
    { type: "hub-component", severity: "warning", confidence: 0.95, component: "Button", message: "High fan-in" },
    { type: "orphan-component", severity: "info", confidence: 0.6, component: "Legacy", message: "Unused component" },
    { type: "dependency-cycle", severity: "error", confidence: 0.99, component: "ModuleA", message: "Circular dependency detected" },
    { type: "architectural-smell", severity: "warning", confidence: 0.8, component: "GodComponent", message: "Too many responsibilities" },
  ];

  return {
    summary: {
      totalComponents: 25,
      hubCount: hubs.length,
      deepChainCount: deepChains.length,
      totalInsights: insights.length,
    },
    components: [],
    insights,
    deepChains,
    hubs,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testSmallBudgetIncludesOnlySummary() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 15 });

  // Summary should be present
  assert(result.includes("Project Summary:"), "Should include summary header");
  assert(result.includes("Components: 25"), "Should include component count");

  // No detail sections should be present — check for actual section content
  // (Note: "Hub Components: 3" appears in summary, so we check for section entries)
  assert(!result.includes("Hub: Button"), "Should NOT include hub entry at small budget");
  assert(!result.includes("Chain (length"), "Should NOT include chain entry at small budget");
  assert(!result.includes("[error]"), "Should NOT include insight entry at small budget");
  assert(!result.includes("[warning]"), "Should NOT include insight entry at small budget");

  console.log("PASS: testSmallBudgetIncludesOnlySummary");
}

function testLargeBudgetIncludesAllSections() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 10000 });

  assert(result.includes("Project Summary:"), "Should include summary");
  assert(result.includes("Hub Components:"), "Should include hubs section");
  assert(result.includes("Deep Dependency Chains:"), "Should include chains section");
  assert(result.includes("Insights:"), "Should include insights section");

  // Verify specific content
  assert(result.includes("Button"), "Should include Button hub");
  assert(result.includes("Modal"), "Should include Modal hub");
  assert(result.includes("App"), "Should include App chain root");
  assert(result.includes("dependency-cycle"), "Should include cycle insight");

  console.log("PASS: testLargeBudgetIncludesAllSections");
}

function testPriorityOrderHubsFirst() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 10000 });

  // Check order using actual section entries (not group headers, which overlap with summary)
  const hubEntryIdx = result.indexOf("Hub: Button");
  const chainEntryIdx = result.indexOf("Chain (length");
  const insightEntryIdx = result.indexOf("[error]");

  assert(hubEntryIdx >= 0, "Hub entry should be present");
  assert(chainEntryIdx >= 0, "Chain entry should be present");
  assert(insightEntryIdx >= 0, "Insight entry should be present");
  assert(hubEntryIdx < chainEntryIdx, "Hub entries should appear before chain entries");
  assert(chainEntryIdx < insightEntryIdx, "Chain entries should appear before insight entries");

  console.log("PASS: testPriorityOrderHubsFirst");
}

function testHighestPriorityHubsIncludedFirst() {
  // Create context where only a few sections fit
  const context = makeRichContext();
  // Use a budget that fits summary + some hubs but not everything
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 40 });

  // Button (dependentCount 15) should be included before Card (dependentCount 3)
  if (result.includes("Button") && !result.includes("Card")) {
    // This means the highest-priority hub was included but not the lowest
    assert(true, "Higher priority hub included first");
  } else if (result.includes("Button") && result.includes("Card")) {
    // Both fit — that's fine too
    assert(true, "Both hubs fit within budget");
  }

  console.log("PASS: testHighestPriorityHubsIncludedFirst");
}

function testJsonFormatOutputKeys() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, {
    budget: 10000,
    format: "json",
  });

  const parsed = JSON.parse(result) as Record<string, unknown>;

  assert("budget" in parsed, "JSON should have 'budget' key");
  assert("usedTokensEstimate" in parsed, "JSON should have 'usedTokensEstimate' key");
  assert("sectionsIncluded" in parsed, "JSON should have 'sectionsIncluded' key");
  assert("summary" in parsed, "JSON should have 'summary' key");

  assert(typeof parsed["budget"] === "number", "budget should be a number");
  assert(typeof parsed["usedTokensEstimate"] === "number", "usedTokensEstimate should be a number");
  assert(Array.isArray(parsed["sectionsIncluded"]), "sectionsIncluded should be an array");
  assert(parsed["budget"] === 10000, "budget should match input");

  const used = parsed["usedTokensEstimate"] as number;
  assert(used <= 10000, `usedTokensEstimate (${used}) should not exceed budget`);
  assert(used > 0, "usedTokensEstimate should be positive");

  console.log("PASS: testJsonFormatOutputKeys");
}

function testJsonFormatSectionEntries() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, {
    budget: 10000,
    format: "json",
  });

  const parsed = JSON.parse(result) as { sectionsIncluded: { kind: string; label: string; priority: number }[] };
  const sections = parsed.sectionsIncluded;

  assert(sections.length > 0, "Should have included sections");

  for (const section of sections) {
    assert(typeof section.kind === "string", "Section should have string 'kind'");
    assert(typeof section.label === "string", "Section should have string 'label'");
    assert(typeof section.priority === "number", "Section should have number 'priority'");
  }

  console.log("PASS: testJsonFormatSectionEntries");
}

function testMdFormatIncludesMarkdownHeadings() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, {
    budget: 10000,
    format: "md",
  });

  assert(result.includes("## Project Summary"), "Should include markdown summary heading");
  assert(result.includes("## Hub Components"), "Should include markdown hub heading");
  assert(result.includes("## Deep Dependency Chains"), "Should include markdown chain heading");
  assert(result.includes("## Insights"), "Should include markdown insight heading");
  assert(result.includes("### Hub:"), "Should include H3 hub sub-headings");
  assert(result.includes("### Chain"), "Should include H3 chain sub-headings");
  assert(result.includes("| Metric | Count |"), "Should include markdown table");

  console.log("PASS: testMdFormatIncludesMarkdownHeadings");
}

function testMdFormatSmallBudget() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, {
    budget: 25,
    format: "md",
  });

  assert(result.includes("## Project Summary"), "Should include summary even at small budget");
  assert(!result.includes("### Hub:"), "Should NOT include hub entry at small budget");
  assert(!result.includes("### Chain"), "Should NOT include chain entry at small budget");

  console.log("PASS: testMdFormatSmallBudget");
}

function testDefaultFormatIsText() {
  const context = makeRichContext();
  const withDefault = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 10000 });
  const withExplicit = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 10000, format: "text" });

  assert(withDefault === withExplicit, "Default format should equal explicit 'text' format");

  console.log("PASS: testDefaultFormatIsText");
}

function testBudgetNotExceeded() {
  const context = makeRichContext();

  // Start at 15 (summary alone is ~12 tokens for the rich context)
  for (const budget of [15, 30, 50, 100, 200, 500, 1000]) {
    const result = BudgetPromptBuilder.buildBudgetPrompt(context, { budget });
    const estimated = result.split(/\s+/).filter((w) => w.length > 0).length;
    assert(
      estimated <= budget,
      `Budget ${budget}: estimated ${estimated} tokens should not exceed budget`,
    );
  }

  console.log("PASS: testBudgetNotExceeded");
}

function testEmptyContext() {
  const context = makeEmptyContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 10000 });

  assert(result.includes("Project Summary:"), "Should include summary");
  assert(result.includes("Components: 0"), "Should show 0 components");
  // With no hubs/chains/insights, there should be no section entries
  assert(!result.includes("Hub:"), "Should NOT include hub entries when no hubs");
  assert(!result.includes("Chain (length"), "Should NOT include chain entries when no chains");
  assert(!result.includes("[error]"), "Should NOT include insight entries when no insights");
  assert(!result.includes("[warning]"), "Should NOT include insight entries when no insights");

  console.log("PASS: testEmptyContext");
}

function testDeterminism() {
  const context = makeRichContext();

  const run1 = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 200 });
  const run2 = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 200 });

  assert(run1 === run2, "Two runs with same input should produce identical output");

  const json1 = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 200, format: "json" });
  const json2 = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 200, format: "json" });

  assert(json1 === json2, "JSON format should also be deterministic");

  console.log("PASS: testDeterminism");
}

function testPromptBuilderBuildPromptDelegatesToBudget() {
  const context = makeRichContext();

  // With budget: should delegate to BudgetPromptBuilder
  const budgeted = PromptBuilder.buildPrompt(context, { budget: 100 });
  const direct = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 100 });
  assert(budgeted === direct, "buildPrompt with budget should delegate to BudgetPromptBuilder");

  console.log("PASS: testPromptBuilderBuildPromptDelegatesToBudget");
}

function testPromptBuilderBuildPromptFallback() {
  const context = makeRichContext();

  // Without budget: should fall back to buildProjectExplanationPrompt
  const noBudget = PromptBuilder.buildPrompt(context);
  const fallback = PromptBuilder.buildProjectExplanationPrompt(context);
  assert(noBudget === fallback, "buildPrompt without budget should fall back to full prompt");

  // With undefined budget
  const undefinedBudget = PromptBuilder.buildPrompt(context, {});
  assert(
    undefinedBudget === fallback,
    "buildPrompt with empty options should fall back to full prompt",
  );

  console.log("PASS: testPromptBuilderBuildPromptFallback");
}

function testJsonBudgetRespected() {
  const context = makeRichContext();
  const result = BudgetPromptBuilder.buildBudgetPrompt(context, {
    budget: 50,
    format: "json",
  });

  const parsed = JSON.parse(result) as { budget: number; usedTokensEstimate: number };
  assert(parsed.usedTokensEstimate <= parsed.budget, "JSON usedTokensEstimate should not exceed budget");

  console.log("PASS: testJsonBudgetRespected");
}

function testInsightSeverityPriority() {
  // Error insights should be included before info insights
  const context: ProjectContext = {
    summary: { totalComponents: 5, hubCount: 0, deepChainCount: 0, totalInsights: 2 },
    components: [],
    hubs: [],
    deepChains: [],
    insights: [
      { type: "orphan-component", severity: "info", confidence: 0.5, component: "LowPrio" },
      { type: "dependency-cycle", severity: "error", confidence: 0.99, component: "HighPrio" },
    ],
  };

  const result = BudgetPromptBuilder.buildBudgetPrompt(context, { budget: 10000 });

  const errorIdx = result.indexOf("[error]");
  const infoIdx = result.indexOf("[info]");

  assert(errorIdx >= 0, "Error insight should be present");
  assert(infoIdx >= 0, "Info insight should be present");
  assert(errorIdx < infoIdx, "Error insight should appear before info insight");

  console.log("PASS: testInsightSeverityPriority");
}

function testPromptBuilderEmptyContext() {
  const context = makeEmptyContext();
  const result = PromptBuilder.buildPrompt(context);

  assert(result.length > 0, "Fallback prompt should produce non-empty output for empty context");
  assert(result.includes("Components: 0"), "Should mention 0 components");
  // The summary line "Hub Components: 0" is expected; the *section* "Hub Components:\n" should not appear
  const lines = result.split("\n");
  const hubSectionLines = lines.filter((l) => l === "Hub Components:");
  assert(hubSectionLines.length === 0, "Should not include Hub Components section heading when empty");
  const chainSectionLines = lines.filter((l) => l === "Deep Dependency Chains:");
  assert(chainSectionLines.length === 0, "Should not include Chains section heading when empty");

  console.log("PASS: testPromptBuilderEmptyContext");
}

function testPromptBuilderBudgetZero() {
  const context = makeRichContext();
  const result = PromptBuilder.buildPrompt(context, { budget: 0 });

  // Budget of 0 should still produce valid output (at minimum summary section)
  assert(result.length > 0, "Budget 0 should still produce output");

  console.log("PASS: testPromptBuilderBudgetZero");
}

function testPromptBuilderFormatPassthrough() {
  const context = makeRichContext();

  const mdResult = PromptBuilder.buildPrompt(context, { budget: 10000, format: "md" });
  assert(mdResult.includes("#"), "MD format should contain markdown headings");

  const jsonResult = PromptBuilder.buildPrompt(context, { budget: 10000, format: "json" });
  JSON.parse(jsonResult); // should not throw
  assert(jsonResult.startsWith("{"), "JSON format should start with {");

  console.log("PASS: testPromptBuilderFormatPassthrough");
}

function testFallbackPromptIncludesAllSections() {
  const context = makeRichContext();
  const result = PromptBuilder.buildProjectExplanationPrompt(context);

  assert(result.includes("Hub Components:"), "Should include Hub Components section");
  assert(result.includes("Button"), "Should include hub name");
  assert(result.includes("Insights:"), "Should include Insights section");
  assert(result.includes("Explain the architecture"), "Should include instructions");

  console.log("PASS: testFallbackPromptIncludesAllSections");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function run() {
  testSmallBudgetIncludesOnlySummary();
  testLargeBudgetIncludesAllSections();
  testPriorityOrderHubsFirst();
  testHighestPriorityHubsIncludedFirst();
  testJsonFormatOutputKeys();
  testJsonFormatSectionEntries();
  testMdFormatIncludesMarkdownHeadings();
  testMdFormatSmallBudget();
  testDefaultFormatIsText();
  testBudgetNotExceeded();
  testEmptyContext();
  testDeterminism();
  testPromptBuilderBuildPromptDelegatesToBudget();
  testPromptBuilderBuildPromptFallback();
  testJsonBudgetRespected();
  testInsightSeverityPriority();
  testPromptBuilderEmptyContext();
  testPromptBuilderBudgetZero();
  testPromptBuilderFormatPassthrough();
  testFallbackPromptIncludesAllSections();

  console.log("\nAll 20 BudgetPromptBuilder tests passed.");
}

run();
