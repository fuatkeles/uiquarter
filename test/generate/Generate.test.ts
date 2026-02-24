import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import type { ProjectContext } from "../../src/context/ContextBuilder.js";
import type { GeneratorContext, ConventionContext } from "../../src/generate/types.js";
import {
  buildOverviewSection,
  buildCompactOverviewSection,
  buildConventionsSection,
  buildCompactConventionsSection,
  buildKeyComponentsSection,
  buildHubsOnlySection,
  buildComponentTableSection,
  buildDependencySection,
  buildInsightsSection,
  buildTopInsightsSection,
  buildGuidelinesSection,
  buildDirectiveGuidelinesSection,
  buildInstructionGuidelinesSection,
  composeSectionsWithBudget,
} from "../../src/generate/sections.js";
import { formatClaude } from "../../src/generate/formatters/claude.js";
import { formatCodex } from "../../src/generate/formatters/codex.js";
import { formatCursor } from "../../src/generate/formatters/cursor.js";
import { formatWindsurf } from "../../src/generate/formatters/windsurf.js";
import { formatCline } from "../../src/generate/formatters/cline.js";
import { formatCopilot } from "../../src/generate/formatters/copilot.js";
import { formatAider } from "../../src/generate/formatters/aider.js";
import { getAllTargetNames, getTargetConfig } from "../../src/generate/registry.js";
import { runGenerateCommand } from "../../src/cli/generate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function pass(name: string): void {
  console.log(`  PASS: ${name}`);
  passed++;
}

function fail(name: string, err: unknown): void {
  console.error(`  FAIL: ${name} — ${err instanceof Error ? err.message : String(err)}`);
  failed++;
}

function makeTestDir(): string {
  return join(
    tmpdir(),
    "uiq-gen-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
  );
}

function makeMockConventions(): ConventionContext {
  return {
    dominantFileNaming: "PascalCase",
    dominantDirNaming: "kebab-case",
    testStrategy: "co-located",
    styleStrategy: "separated",
    barrelCount: 3,
    componentDirCount: 5,
    totalDirectories: 12,
    totalFiles: 45,
  };
}

function makeMockProject(): ProjectContext {
  return {
    summary: {
      totalComponents: 3,
      totalInsights: 2,
      hubCount: 1,
      deepChainCount: 1,
    },
    components: [
      { name: "App", filePath: "src/App.tsx", dependencyCount: 2, dependentCount: 0, isHub: false, isOrphan: false },
      { name: "Button", filePath: "src/Button.tsx", dependencyCount: 0, dependentCount: 5, isHub: true, isOrphan: false },
      { name: "Footer", filePath: "src/Footer.tsx", dependencyCount: 0, dependentCount: 0, isHub: false, isOrphan: true },
    ],
    hubs: [
      { component: "Button", dependentCount: 5, confidence: 0.85 },
    ],
    deepChains: [
      { length: 4, root: "App", leaf: "Icon", components: ["App", "Layout", "Sidebar", "Icon"] },
    ],
    insights: [
      { type: "hub-component", severity: "info", confidence: 0.85, component: "Button", message: "Button is a hub" },
      { type: "orphan-component", severity: "warning", confidence: 0.7, component: "Footer" },
    ],
  };
}

function makeMockContext(withConventions = true): GeneratorContext {
  return {
    project: makeMockProject(),
    conventions: withConventions ? makeMockConventions() : null,
  };
}

function makeMockEmptyContext(): GeneratorContext {
  return {
    project: {
      summary: { totalComponents: 0, totalInsights: 0, hubCount: 0, deepChainCount: 0 },
      components: [],
      hubs: [],
      deepChains: [],
      insights: [],
    },
    conventions: null,
  };
}

async function createProjectWithIndex(): Promise<string> {
  const root = makeTestDir();
  const srcDir = join(root, "src");
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(srcDir, "App.tsx"),
    `import { Button } from "./Button";\nexport default function App() { return <Button />; }\n`,
  );
  await writeFile(
    join(srcDir, "Button.tsx"),
    `export function Button() { return <button>Click</button>; }\n`,
  );

  execSync("node dist/cli.js init -d " + JSON.stringify(root), {
    cwd: join(__dirname, "..", ".."),
    stdio: "pipe",
  });

  return root;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Section builder tests
// ---------------------------------------------------------------------------

function testOverviewSection() {
  const ctx = makeMockContext();
  const output = buildOverviewSection(ctx);
  assert(output.includes("3"), "Should mention 3 components");
  assert(output.includes("1"), "Should mention 1 hub");
  assert(output.includes("Architecture Overview"), "Should have header");
  pass("testOverviewSection");
}

function testCompactOverviewSection() {
  const ctx = makeMockContext();
  const output = buildCompactOverviewSection(ctx);
  assert(output.includes("3 components"), "Should mention 3 components compactly");
  assert(output.includes("1 hubs"), "Should mention 1 hub");
  assert(output.length < buildOverviewSection(ctx).length, "Compact should be shorter");
  pass("testCompactOverviewSection");
}

function testConventionsSectionWithData() {
  const output = buildConventionsSection(makeMockConventions());
  assert(output.includes("PascalCase"), "Should show file naming");
  assert(output.includes("kebab-case"), "Should show dir naming");
  assert(output.includes("co-located"), "Should show test strategy");
  assert(output.includes("separated"), "Should show style strategy");
  assert(output.includes("3"), "Should show barrel count");
  pass("testConventionsSectionWithData");
}

function testConventionsSectionNull() {
  const output = buildConventionsSection(null);
  assert(output === "", "Should return empty for null conventions");
  pass("testConventionsSectionNull");
}

function testKeyComponentsSection() {
  const ctx = makeMockContext();
  const output = buildKeyComponentsSection(ctx);
  assert(output.includes("Button"), "Should mention hub");
  assert(output.includes("5 dependents"), "Should show dependent count");
  assert(output.includes("Footer"), "Should mention orphan");
  assert(output.includes("Orphan"), "Should have orphan section");
  pass("testKeyComponentsSection");
}

function testHubsOnlySection() {
  const ctx = makeMockContext();
  const output = buildHubsOnlySection(ctx);
  assert(output.includes("Button"), "Should mention hub");
  assert(!output.includes("Footer"), "Should NOT mention orphan");
  pass("testHubsOnlySection");
}

function testComponentTableSection() {
  const ctx = makeMockContext();
  const output = buildComponentTableSection(ctx);
  assert(output.includes("| App |"), "Should have App row");
  assert(output.includes("| Button |"), "Should have Button row");
  assert(output.includes("hub"), "Should tag hub");
  assert(output.includes("orphan"), "Should tag orphan");
  pass("testComponentTableSection");
}

function testDependencySection() {
  const ctx = makeMockContext();
  const output = buildDependencySection(ctx);
  assert(output.includes("Length 4"), "Should show chain length");
  assert(output.includes("App"), "Should mention root");
  assert(output.includes("Icon"), "Should mention leaf");
  pass("testDependencySection");
}

function testInsightsSection() {
  const ctx = makeMockContext();
  const output = buildInsightsSection(ctx);
  assert(output.includes("warning"), "Should show warning severity");
  assert(output.includes("hub-component"), "Should show insight type");
  assert(output.includes("Button"), "Should mention component");
  pass("testInsightsSection");
}

function testTopInsightsSection() {
  const ctx = makeMockContext();
  const output = buildTopInsightsSection(ctx, 1);
  // Only top 1 — warning should come first (sorted by severity)
  const lines = output.split("\n").filter((l) => l.startsWith("- "));
  assert(lines.length === 1, `Should have exactly 1 insight, got ${lines.length}`);
  pass("testTopInsightsSection");
}

function testGuidelinesSection() {
  const ctx = makeMockContext();
  const output = buildGuidelinesSection(ctx);
  assert(output.includes("Hub components"), "Should warn about hubs");
  assert(output.includes("Button"), "Should mention hub name");
  assert(output.includes("Deep dependency chains"), "Should warn about chains");
  assert(output.includes("Orphan"), "Should warn about orphans");
  pass("testGuidelinesSection");
}

function testDirectiveGuidelinesSection() {
  const ctx = makeMockContext();
  const output = buildDirectiveGuidelinesSection(ctx);
  assert(output.includes("When modifying"), "Should use directive style");
  assert(output.includes("`Button`"), "Should reference Button in code");
  pass("testDirectiveGuidelinesSection");
}

function testInstructionGuidelinesSection() {
  const ctx = makeMockContext();
  const output = buildInstructionGuidelinesSection(ctx);
  assert(output.includes("When modifying"), "Should use instruction style");
  assert(output.includes("hub components"), "Should mention hubs");
  pass("testInstructionGuidelinesSection");
}

function testEmptySectionsReturnEmpty() {
  const ctx = makeMockEmptyContext();
  assert(buildKeyComponentsSection(ctx) === "", "Key components empty for no data");
  assert(buildDependencySection(ctx) === "", "Dependency empty for no data");
  assert(buildInsightsSection(ctx) === "", "Insights empty for no data");
  assert(buildGuidelinesSection(ctx) === "", "Guidelines empty for no data");
  assert(buildComponentTableSection(ctx) === "", "Table empty for no data");
  assert(buildHubsOnlySection(ctx) === "", "Hubs only empty for no data");
  pass("testEmptySectionsReturnEmpty");
}

// ---------------------------------------------------------------------------
// Budget helper tests
// ---------------------------------------------------------------------------

function testBudgetAlwaysIncludesFirst() {
  const sections = ["HEADER (very long)".repeat(100), "Section2"];
  const result = composeSectionsWithBudget(sections, 10);
  assert(result.includes("HEADER"), "Should always include first section");
  assert(!result.includes("Section2"), "Should not include second when over budget");
  pass("testBudgetAlwaysIncludesFirst");
}

function testBudgetFitsAll() {
  const sections = ["A", "B", "C"];
  const result = composeSectionsWithBudget(sections, 10000);
  assert(result.includes("A"), "Should include A");
  assert(result.includes("B"), "Should include B");
  assert(result.includes("C"), "Should include C");
  pass("testBudgetFitsAll");
}

function testBudgetDropsExcess() {
  const sections = ["AAA", "B".repeat(100), "CCC"];
  // Budget = 15: "AAA" (3) + "\n\n" (2) + "CCC" (3) = 8 fits, but "B*100" doesn't
  const result = composeSectionsWithBudget(sections, 15);
  assert(result.includes("AAA"), "Should include first");
  assert(result.includes("CCC"), "Should include third (fits)");
  assert(!result.includes("BBB"), "Should NOT include second (too large)");
  pass("testBudgetDropsExcess");
}

function testBudgetEmptySections() {
  const result = composeSectionsWithBudget(["", "", ""], 1000);
  assert(result === "", "Should return empty for all-empty sections");
  pass("testBudgetEmptySections");
}

// ---------------------------------------------------------------------------
// Formatter tests
// ---------------------------------------------------------------------------

function testClaudeFormatter() {
  const files = formatClaude(makeMockContext(), {});
  assert(files.length === 1, "Should produce 1 file");
  assert(files[0]!.relativePath === "CLAUDE.md", "Should be CLAUDE.md");
  assert(files[0]!.content.includes("Architecture"), "Should have architecture header");
  assert(files[0]!.content.includes("Button"), "Should mention Button");
  assert(files[0]!.content.includes("PascalCase"), "Should include conventions");
  pass("testClaudeFormatter");
}

function testCodexFormatter() {
  const files = formatCodex(makeMockContext(), {});
  assert(files.length === 1, "Should produce 1 file");
  assert(files[0]!.relativePath === "AGENTS.md", "Should be AGENTS.md");
  assert(files[0]!.content.length <= 32_768, `Codex output should be <= 32768 chars, got ${files[0]!.content.length}`);
  pass("testCodexFormatter");
}

function testCursorFormatter() {
  const files = formatCursor(makeMockContext(), {});
  assert(files.length === 1, "Should produce 1 file");
  assert(files[0]!.relativePath === ".cursorrules", "Should be .cursorrules");
  assert(files[0]!.content.includes("Button"), "Should mention Button");
  pass("testCursorFormatter");
}

function testWindsurfFormatter() {
  const files = formatWindsurf(makeMockContext(), {});
  assert(files.length === 1, "Should produce 1 file");
  assert(files[0]!.relativePath === ".windsurfrules", "Should be .windsurfrules");
  assert(files[0]!.content.length <= 6_000, `Windsurf output should be <= 6000 chars, got ${files[0]!.content.length}`);
  pass("testWindsurfFormatter");
}

function testClineFormatter() {
  const files = formatCline(makeMockContext(), {});
  assert(files.length === 1, "Should produce 1 file");
  assert(files[0]!.relativePath === ".clinerules", "Should be .clinerules");
  pass("testClineFormatter");
}

function testCopilotFormatter() {
  const files = formatCopilot(makeMockContext(), {});
  assert(files.length === 1, "Should produce 1 file");
  assert(files[0]!.relativePath === ".github/copilot-instructions.md", "Should be .github/copilot-instructions.md");
  assert(files[0]!.content.includes("Project Context"), "Should have project context header");
  pass("testCopilotFormatter");
}

function testAiderFormatter() {
  const files = formatAider(makeMockContext(), {});
  assert(files.length === 1, "Should produce 1 file");
  assert(files[0]!.relativePath === "CONVENTIONS.md", "Should be CONVENTIONS.md");
  assert(files[0]!.content.includes("Conventions"), "Should have conventions header");
  pass("testAiderFormatter");
}

function testEmptyContextProducesValidOutput() {
  const ctx = makeMockEmptyContext();
  const allFormatters = [formatClaude, formatCodex, formatCursor, formatWindsurf, formatCline, formatCopilot, formatAider];
  for (const formatter of allFormatters) {
    const files = formatter(ctx, {});
    assert(files.length >= 1, "Should produce at least 1 file for empty context");
    assert(files[0]!.content.length > 0, "Content should be non-empty for empty context");
    assert(files[0]!.content.includes("0"), "Should mention 0 components");
  }
  pass("testEmptyContextProducesValidOutput");
}

function testWithoutConventions() {
  const ctx = makeMockContext(false);
  const files = formatClaude(ctx, {});
  assert(!files[0]!.content.includes("PascalCase"), "Should NOT include conventions when null");
  assert(!files[0]!.content.includes("Coding Conventions"), "Should NOT have conventions section");
  pass("testWithoutConventions");
}

function testFormattersDeterministic() {
  const ctx = makeMockContext();
  const allFormatters = [formatClaude, formatCodex, formatCursor, formatWindsurf, formatCline, formatCopilot, formatAider];
  for (const formatter of allFormatters) {
    const run1 = formatter(ctx, {});
    const run2 = formatter(ctx, {});
    assert(run1.length === run2.length, "Should produce same number of files");
    for (let i = 0; i < run1.length; i++) {
      assert(run1[i]!.content === run2[i]!.content, `Content should be identical for ${run1[i]!.relativePath}`);
    }
  }
  pass("testFormattersDeterministic");
}

function testProjectNameOption() {
  const files = formatClaude(makeMockContext(), { projectName: "MyApp" });
  assert(files[0]!.content.includes("MyApp"), "Should use provided project name");
  pass("testProjectNameOption");
}

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

function testRegistryAllTargets() {
  const names = getAllTargetNames();
  assert(names.length === 7, `Should have 7 targets, got ${names.length}`);
  assert(names.includes("claude"), "Should include claude");
  assert(names.includes("codex"), "Should include codex");
  assert(names.includes("cursor"), "Should include cursor");
  assert(names.includes("windsurf"), "Should include windsurf");
  assert(names.includes("cline"), "Should include cline");
  assert(names.includes("copilot"), "Should include copilot");
  assert(names.includes("aider"), "Should include aider");
  pass("testRegistryAllTargets");
}

function testRegistrySorted() {
  const names = getAllTargetNames();
  const sorted = [...names].sort();
  assert(JSON.stringify(names) === JSON.stringify(sorted), "Target names should be alphabetically sorted");
  pass("testRegistrySorted");
}

function testRegistryUnknownTarget() {
  try {
    getTargetConfig("nonexistent" as any);
    assert(false, "Should throw for unknown target");
  } catch (err) {
    assert(err instanceof Error, "Should throw Error");
    assert(err.message.includes("Unknown"), "Should mention unknown");
  }
  pass("testRegistryUnknownTarget");
}

function testRegistryCharBudgets() {
  const codex = getTargetConfig("codex");
  assert(codex.defaultCharBudget === 32_768, "Codex budget should be 32768");
  const windsurf = getTargetConfig("windsurf");
  assert(windsurf.defaultCharBudget === 6_000, "Windsurf budget should be 6000");
  const claude = getTargetConfig("claude");
  assert(claude.defaultCharBudget === undefined, "Claude should have no budget");
  pass("testRegistryCharBudgets");
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

async function testGenerateSingleTarget() {
  const root = await createProjectWithIndex();
  try {
    await runGenerateCommand({ target: "claude", dir: root });
    const claudeMd = await readFile(join(root, "CLAUDE.md"), "utf-8");
    assert(claudeMd.length > 0, "CLAUDE.md should be non-empty");
    assert(claudeMd.includes("Architecture"), "CLAUDE.md should have architecture header");
    pass("testGenerateSingleTarget");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testGenerateAllTargets() {
  const root = await createProjectWithIndex();
  try {
    await runGenerateCommand({ target: "all", dir: root });

    const expectedFiles = [
      "CLAUDE.md",
      "AGENTS.md",
      ".cursorrules",
      ".windsurfrules",
      ".clinerules",
      ".github/copilot-instructions.md",
      "CONVENTIONS.md",
    ];

    for (const file of expectedFiles) {
      const exists = await fileExists(join(root, file));
      assert(exists, `${file} should exist after --target all`);
    }

    pass("testGenerateAllTargets");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testGenerateDryRun() {
  const root = await createProjectWithIndex();
  try {
    // Capture stdout
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    await runGenerateCommand({ target: "claude", dir: root, dryRun: true });

    process.stdout.write = originalWrite;

    assert(output.includes("[dry-run]"), "Should print dry-run prefix");
    assert(output.includes("CLAUDE.md"), "Should mention CLAUDE.md in dry-run");

    const exists = await fileExists(join(root, "CLAUDE.md"));
    assert(!exists, "CLAUDE.md should NOT be written in dry-run");

    pass("testGenerateDryRun");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testGenerateMissingIndex() {
  const root = makeTestDir();
  await mkdir(root, { recursive: true });
  try {
    await runGenerateCommand({ target: "claude", dir: root });
    assert(false, "Should throw for missing index");
  } catch (err) {
    assert(err instanceof Error, "Should throw Error");
    assert(err.message.includes("init"), "Should suggest running init");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  pass("testGenerateMissingIndex");
}

async function testWindsurfBudgetWithRealProject() {
  const root = await createProjectWithIndex();
  try {
    await runGenerateCommand({ target: "windsurf", dir: root });
    const content = await readFile(join(root, ".windsurfrules"), "utf-8");
    assert(content.length <= 6_000, `Windsurf output should be <= 6000 chars, got ${content.length}`);
    assert(content.length > 0, "Windsurf output should be non-empty");
    pass("testWindsurfBudgetWithRealProject");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Generate tests\n");

  // Section builder tests
  console.log("Section builders:");
  testOverviewSection();
  testCompactOverviewSection();
  testConventionsSectionWithData();
  testConventionsSectionNull();
  testKeyComponentsSection();
  testHubsOnlySection();
  testComponentTableSection();
  testDependencySection();
  testInsightsSection();
  testTopInsightsSection();
  testGuidelinesSection();
  testDirectiveGuidelinesSection();
  testInstructionGuidelinesSection();
  testEmptySectionsReturnEmpty();

  // Budget tests
  console.log("\nBudget helpers:");
  testBudgetAlwaysIncludesFirst();
  testBudgetFitsAll();
  testBudgetDropsExcess();
  testBudgetEmptySections();

  // Formatter tests
  console.log("\nFormatters:");
  testClaudeFormatter();
  testCodexFormatter();
  testCursorFormatter();
  testWindsurfFormatter();
  testClineFormatter();
  testCopilotFormatter();
  testAiderFormatter();
  testEmptyContextProducesValidOutput();
  testWithoutConventions();
  testFormattersDeterministic();
  testProjectNameOption();

  // Registry tests
  console.log("\nRegistry:");
  testRegistryAllTargets();
  testRegistrySorted();
  testRegistryUnknownTarget();
  testRegistryCharBudgets();

  // Integration tests
  console.log("\nIntegration:");
  await testGenerateSingleTarget();
  await testGenerateAllTargets();
  await testGenerateDryRun();
  await testGenerateMissingIndex();
  await testWindsurfBudgetWithRealProject();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
