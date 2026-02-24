import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  formatContextJson,
  formatContextText,
  formatContextMarkdown,
  formatResolveJson,
  formatResolveText,
  formatResolveMarkdown,
  runExportCommand,
} from "../../src/cli/export.js";
import type { ProjectContext } from "../../src/context/ContextBuilder.js";
import type { ScoredMatch } from "../../src/query/ResolverScorer.js";
import type { PatternId } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function makeTestDir(): string {
  return join(
    tmpdir(),
    "uiq-export-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
  );
}

/** Create a minimal project with .uiq index for integration tests. */
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

  // Run init to build the .uiq index
  execSync("node dist/cli.js init -d " + JSON.stringify(root), {
    cwd: join(__dirname, "..", ".."),
    stdio: "pipe",
  });

  return root;
}

/** Minimal ProjectContext for formatter unit tests. */
function makeMockContext(): ProjectContext {
  return {
    summary: {
      totalComponents: 3,
      totalInsights: 2,
      hubCount: 1,
      deepChainCount: 0,
    },
    components: [
      {
        name: "App",
        filePath: "src/App.tsx",
        dependencyCount: 2,
        dependentCount: 0,
        isHub: false,
        isOrphan: false,
      },
      {
        name: "Button",
        filePath: "src/Button.tsx",
        dependencyCount: 0,
        dependentCount: 1,
        isHub: true,
        isOrphan: false,
      },
      {
        name: "Footer",
        filePath: "src/Footer.tsx",
        dependencyCount: 0,
        dependentCount: 0,
        isHub: false,
        isOrphan: true,
      },
    ],
    hubs: [
      { component: "Button", dependentCount: 5, confidence: 0.85 },
    ],
    deepChains: [],
    insights: [
      { type: "hub-component", severity: "info", confidence: 0.85, component: "Button", message: "Button is a hub" },
      { type: "orphan-component", severity: "warning", confidence: 0.7, component: "Footer" },
    ],
  };
}

function makeMockScoredMatches(debug: boolean): readonly ScoredMatch[] {
  return [
    {
      patternId: "src/Button.tsx:Button:1" as PatternId,
      score: 2.0,
      matchedTokens: ["button"],
      reasons: debug
        ? [{ token: "button", kind: "exact" as const, weight: 1.0, description: 'Exact token match on "button" (+1.0)' }]
        : [],
    },
    {
      patternId: "src/App.tsx:App:1" as PatternId,
      score: 1.0,
      matchedTokens: ["app"],
      reasons: debug
        ? [{ token: "app", kind: "exact" as const, weight: 1.0, description: 'Exact token match on "app" (+1.0)' }]
        : [],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests: Context Formatters
// ---------------------------------------------------------------------------

function testFormatContextJson() {
  const ctx = makeMockContext();
  const output = formatContextJson(ctx);
  const parsed = JSON.parse(output);

  assert(parsed.project !== undefined, "JSON should have 'project' key");
  assert(parsed.components !== undefined, "JSON should have 'components' key");
  assert(parsed.hubs !== undefined, "JSON should have 'hubs' key");
  assert(parsed.deepChains !== undefined, "JSON should have 'deepChains' key");
  assert(parsed.insights !== undefined, "JSON should have 'insights' key");
  assert(parsed.project.totalComponents === 3, "totalComponents should be 3");
  assert(parsed.components.length === 3, "Should have 3 components");
  assert(parsed.hubs.length === 1, "Should have 1 hub");
  assert(parsed.insights.length === 2, "Should have 2 insights");

  console.log("PASS: testFormatContextJson");
}

function testFormatContextText() {
  const ctx = makeMockContext();
  const output = formatContextText(ctx);

  assert(output.includes("Project Context Summary"), "Should have title");
  assert(output.includes("Components: 3"), "Should show component count");
  assert(output.includes("Hub components: 1"), "Should show hub count");
  assert(output.includes("Button"), "Should mention Button");
  assert(output.includes("src/App.tsx"), "Should mention App file path");
  assert(output.includes("[hub]"), "Should tag hub components");
  assert(output.includes("[orphan]"), "Should tag orphan components");
  assert(output.includes("Hub Components:"), "Should have hub section");
  assert(output.includes("Insights:"), "Should have insights section");
  assert(output.includes("[warning]"), "Should show severity");

  console.log("PASS: testFormatContextText");
}

function testFormatContextMarkdown() {
  const ctx = makeMockContext();
  const output = formatContextMarkdown(ctx);

  assert(output.includes("# Project Context"), "Should have markdown title");
  assert(output.includes("## Summary"), "Should have summary heading");
  assert(output.includes("| Components | 3 |"), "Should have component count in table");
  assert(output.includes("## Components"), "Should have components section");
  assert(output.includes("| Name | File |"), "Should have table header");
  assert(output.includes("| Button |"), "Should list Button");
  assert(output.includes("## Hub Components"), "Should have hub section");
  assert(output.includes("**Button**"), "Should bold hub name");
  assert(output.includes("## Insights"), "Should have insights section");

  console.log("PASS: testFormatContextMarkdown");
}

function testFormatContextEmptyProject() {
  const ctx: ProjectContext = {
    summary: { totalComponents: 0, totalInsights: 0, hubCount: 0, deepChainCount: 0 },
    components: [],
    hubs: [],
    deepChains: [],
    insights: [],
  };

  const json = formatContextJson(ctx);
  const parsed = JSON.parse(json);
  assert(parsed.components.length === 0, "Empty project: 0 components");
  assert(parsed.hubs.length === 0, "Empty project: 0 hubs");

  const text = formatContextText(ctx);
  assert(text.includes("Components: 0"), "Text shows 0 components");
  // "Components: 0" contains "Components:" so check for the section header specifically
  assert(!text.includes("Components:\n"), "Text has no Components list section");
  assert(!text.includes("Hub Components:"), "Text has no hub section");

  const md = formatContextMarkdown(ctx);
  assert(md.includes("| Components | 0 |"), "Markdown shows 0 components");

  console.log("PASS: testFormatContextEmptyProject");
}

function testFormatContextJsonKeyOrder() {
  const ctx = makeMockContext();
  const output = formatContextJson(ctx);
  const keys = Object.keys(JSON.parse(output));

  // stableStringify sorts keys alphabetically
  for (let i = 1; i < keys.length; i++) {
    assert(keys[i]! >= keys[i - 1]!, `JSON keys should be sorted: ${keys[i - 1]} <= ${keys[i]}`);
  }

  console.log("PASS: testFormatContextJsonKeyOrder");
}

// ---------------------------------------------------------------------------
// Tests: Resolve Formatters
// ---------------------------------------------------------------------------

function testFormatResolveJsonNoDebug() {
  const results = makeMockScoredMatches(false);
  const output = formatResolveJson(results, false);
  const parsed = JSON.parse(output);

  assert(Array.isArray(parsed), "Should be an array");
  assert(parsed.length === 2, "Should have 2 matches");
  assert(parsed[0].patternId !== undefined, "Should have patternId");
  assert(parsed[0].score !== undefined, "Should have score");
  assert(parsed[0].matchedTokens !== undefined, "Should have matchedTokens");
  assert(parsed[0].reasons === undefined, "Should NOT have reasons when debug=false");

  console.log("PASS: testFormatResolveJsonNoDebug");
}

function testFormatResolveJsonWithDebug() {
  const results = makeMockScoredMatches(true);
  const output = formatResolveJson(results, true);
  const parsed = JSON.parse(output);

  assert(parsed[0].reasons !== undefined, "Should have reasons when debug=true");
  assert(parsed[0].reasons.length > 0, "Should have at least one reason");
  assert(parsed[0].reasons[0].token === "button", "First reason token should be 'button'");
  assert(parsed[0].reasons[0].kind === "exact", "First reason kind should be 'exact'");

  console.log("PASS: testFormatResolveJsonWithDebug");
}

function testFormatResolveText() {
  const results = makeMockScoredMatches(false);
  const output = formatResolveText("add button", results, false);

  assert(output.includes('Resolve: "add button"'), "Should have task in header");
  assert(output.includes("2 match(es)"), "Should show match count");
  assert(output.includes("src/Button.tsx:Button:1"), "Should show patternId");
  assert(output.includes("score: 2.00"), "Should show score");
  assert(!output.includes("[exact]"), "Should NOT show debug info");

  console.log("PASS: testFormatResolveText");
}

function testFormatResolveTextDebug() {
  const results = makeMockScoredMatches(true);
  const output = formatResolveText("add button", results, true);

  assert(output.includes("[exact]"), "Should show match kind");
  assert(output.includes("+1.0"), "Should show weight");
  assert(output.includes("button"), "Should show token");

  console.log("PASS: testFormatResolveTextDebug");
}

function testFormatResolveMarkdown() {
  const results = makeMockScoredMatches(false);
  const output = formatResolveMarkdown("add button", results, false);

  assert(output.includes("# Resolve:"), "Should have markdown heading");
  assert(output.includes("**src/Button.tsx:Button:1**"), "Should bold patternId");
  assert(output.includes("score: 2.00"), "Should show score");

  console.log("PASS: testFormatResolveMarkdown");
}

function testFormatResolveMarkdownDebug() {
  const results = makeMockScoredMatches(true);
  const output = formatResolveMarkdown("add button", results, true);

  assert(output.includes("`button`"), "Should show token in backticks");
  assert(output.includes("(exact,"), "Should show match kind");

  console.log("PASS: testFormatResolveMarkdownDebug");
}

function testFormatResolveEmptyResults() {
  const output = formatResolveJson([], false);
  const parsed = JSON.parse(output);
  assert(Array.isArray(parsed), "Should be an array");
  assert(parsed.length === 0, "Should be empty");

  const text = formatResolveText("nothing", [], false);
  assert(text.includes("0 match(es)"), "Text should show 0 matches");

  const md = formatResolveMarkdown("nothing", [], false);
  assert(md.includes("0 matching pattern(s)"), "Markdown should show 0 matches");

  console.log("PASS: testFormatResolveEmptyResults");
}

// ---------------------------------------------------------------------------
// Tests: runExportCommand integration
// ---------------------------------------------------------------------------

async function testExportContextJsonToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-context.json");
    await runExportCommand({
      type: "context",
      dir: root,
      format: "json",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    const parsed = JSON.parse(content);

    assert(parsed.project !== undefined, "Output should have 'project' key");
    assert(parsed.components !== undefined, "Output should have 'components' key");
    assert(parsed.hubs !== undefined, "Output should have 'hubs' key");
    assert(parsed.deepChains !== undefined, "Output should have 'deepChains' key");
    assert(parsed.insights !== undefined, "Output should have 'insights' key");
    assert(typeof parsed.project.totalComponents === "number", "totalComponents should be a number");

    console.log("PASS: testExportContextJsonToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportContextTxtToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-context.txt");
    await runExportCommand({
      type: "context",
      dir: root,
      format: "txt",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    assert(content.includes("Project Context Summary"), "TXT output should have title");
    assert(content.includes("Components:"), "TXT output should mention components");

    console.log("PASS: testExportContextTxtToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportContextMdToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-context.md");
    await runExportCommand({
      type: "context",
      dir: root,
      format: "md",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    assert(content.includes("# Project Context"), "MD output should have markdown heading");
    assert(content.includes("## Summary"), "MD output should have summary section");

    console.log("PASS: testExportContextMdToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportResolveJsonToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-resolve.json");
    await runExportCommand({
      type: "resolve",
      task: "button component",
      dir: root,
      format: "json",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    const parsed = JSON.parse(content);
    assert(Array.isArray(parsed), "Resolve JSON output should be an array");

    console.log("PASS: testExportResolveJsonToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportResolveTxtToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-resolve.txt");
    await runExportCommand({
      type: "resolve",
      task: "button",
      dir: root,
      format: "txt",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    assert(content.includes("Resolve:"), "TXT resolve output should have header");

    console.log("PASS: testExportResolveTxtToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportResolveWithDebugFlag() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-resolve-debug.json");
    await runExportCommand({
      type: "resolve",
      task: "button",
      dir: root,
      format: "json",
      debug: true,
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    const parsed = JSON.parse(content);
    assert(Array.isArray(parsed), "Should be an array");
    if (parsed.length > 0) {
      assert(parsed[0].reasons !== undefined, "Debug mode should include reasons");
    }

    console.log("PASS: testExportResolveWithDebugFlag");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportResolveMissingTask() {
  const root = await createProjectWithIndex();

  try {
    let threw = false;
    try {
      await runExportCommand({
        type: "resolve",
        dir: root,
        format: "json",
      });
    } catch (err) {
      threw = true;
      assert(
        err instanceof Error && err.message.includes("--task"),
        `Error should mention --task, got: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assert(threw, "Should throw when task is missing for resolve type");

    console.log("PASS: testExportResolveMissingTask");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportContextToStdout() {
  const root = await createProjectWithIndex();

  try {
    // Capture stdout
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      await runExportCommand({
        type: "context",
        dir: root,
        format: "json",
        // no out → stdout
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    assert(output.length > 0, "Should write to stdout");
    const parsed = JSON.parse(output);
    assert(parsed.project !== undefined, "Stdout JSON should have 'project' key");

    console.log("PASS: testExportContextToStdout");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportDefaultFormatIsJson() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-default.out");
    await runExportCommand({
      type: "context",
      dir: root,
      out: outFile,
      // no format → defaults to json
    });

    const content = await readFile(outFile, "utf-8");
    // Should be valid JSON
    JSON.parse(content);
    assert(content.includes('"project"'), "Default format should be JSON");

    console.log("PASS: testExportDefaultFormatIsJson");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Scope export tests
// ---------------------------------------------------------------------------

async function testExportScopeJsonToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-scope.json");
    await runExportCommand({
      type: "scope",
      task: "button",
      dir: root,
      format: "json",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    const parsed = JSON.parse(content);
    assert(parsed.task === "button", "Scope JSON should contain the task");
    assert(parsed.summary !== undefined, "Scope JSON should have summary");
    assert(Array.isArray(parsed.matches), "Scope JSON should have matches array");
    assert(Array.isArray(parsed.files), "Scope JSON should have files array");

    console.log("PASS: testExportScopeJsonToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportScopeTextToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-scope.txt");
    await runExportCommand({
      type: "scope",
      task: "button",
      dir: root,
      format: "txt",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    assert(content.includes("Task:"), "Scope text should have Task: header");
    assert(content.includes("Matched:"), "Scope text should have Matched: line");

    console.log("PASS: testExportScopeTextToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportScopeMdToFile() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-scope.md");
    await runExportCommand({
      type: "scope",
      task: "button",
      dir: root,
      format: "md",
      out: outFile,
    });

    const content = await readFile(outFile, "utf-8");
    assert(content.includes("# Task Context:"), "Scope markdown should have heading");

    console.log("PASS: testExportScopeMdToFile");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportScopeMissingTask() {
  const root = await createProjectWithIndex();

  try {
    let threw = false;
    try {
      await runExportCommand({
        type: "scope",
        dir: root,
        format: "json",
      });
    } catch (err) {
      threw = true;
      assert(
        err instanceof Error && err.message.includes("--task"),
        `Error should mention --task`,
      );
    }
    assert(threw, "Should throw when task is missing for scope type");

    console.log("PASS: testExportScopeMissingTask");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testExportScopeCompactOutput() {
  const root = await createProjectWithIndex();

  try {
    const outFile = join(root, "export-scope-compact.json");
    await runExportCommand({
      type: "scope",
      task: "button",
      dir: root,
      format: "json",
      out: outFile,
    });

    const fullContent = await readFile(outFile, "utf-8");
    const fullContext = JSON.parse(fullContent);

    // Compare with full context export
    const fullOutFile = join(root, "export-full.json");
    await runExportCommand({
      type: "context",
      dir: root,
      format: "json",
      out: fullOutFile,
    });

    const fullContextContent = await readFile(fullOutFile, "utf-8");

    // Scope output should be smaller than or equal to full context
    assert(
      fullContent.length <= fullContextContent.length + 500,
      `Scope output (${fullContent.length}) should not be much larger than full context (${fullContextContent.length})`,
    );

    console.log("PASS: testExportScopeCompactOutput");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function testFormatDeterminism() {
  const ctx = makeMockContext();

  const json1 = formatContextJson(ctx);
  const json2 = formatContextJson(ctx);
  assert(json1 === json2, "Context JSON should be deterministic");

  const text1 = formatContextText(ctx);
  const text2 = formatContextText(ctx);
  assert(text1 === text2, "Context text should be deterministic");

  const md1 = formatContextMarkdown(ctx);
  const md2 = formatContextMarkdown(ctx);
  assert(md1 === md2, "Context markdown should be deterministic");

  const results = makeMockScoredMatches(true);
  const rj1 = formatResolveJson(results, true);
  const rj2 = formatResolveJson(results, true);
  assert(rj1 === rj2, "Resolve JSON should be deterministic");

  console.log("PASS: testFormatDeterminism");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  // Context formatter unit tests
  testFormatContextJson();
  testFormatContextText();
  testFormatContextMarkdown();
  testFormatContextEmptyProject();
  testFormatContextJsonKeyOrder();

  // Resolve formatter unit tests
  testFormatResolveJsonNoDebug();
  testFormatResolveJsonWithDebug();
  testFormatResolveText();
  testFormatResolveTextDebug();
  testFormatResolveMarkdown();
  testFormatResolveMarkdownDebug();
  testFormatResolveEmptyResults();

  // Determinism
  testFormatDeterminism();

  // Integration tests (require built project + init)
  await testExportContextJsonToFile();
  await testExportContextTxtToFile();
  await testExportContextMdToFile();
  await testExportResolveJsonToFile();
  await testExportResolveTxtToFile();
  await testExportResolveWithDebugFlag();
  await testExportResolveMissingTask();
  await testExportContextToStdout();
  await testExportDefaultFormatIsJson();

  // Scope export integration tests
  await testExportScopeJsonToFile();
  await testExportScopeTextToFile();
  await testExportScopeMdToFile();
  await testExportScopeMissingTask();
  await testExportScopeCompactOutput();

  console.log("\nAll 27 Export tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
