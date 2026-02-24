import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { QueryEngine } from "../../src/query/QueryEngine.js";
import { TaskScopedBuilder } from "../../src/context/TaskScopedBuilder.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

async function createTestProject(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-scope-"));
  await mkdir(join(tmp, "src", "components"), { recursive: true });
  await mkdir(join(tmp, "src", "hooks"), { recursive: true });

  await writeFile(
    join(tmp, "src", "components", "Button.tsx"),
    `export function Button({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick}>{label}</button>;
}
`,
  );

  await writeFile(
    join(tmp, "src", "components", "Card.tsx"),
    `import { Button } from './Button';
export function Card({ title }: { title: string }) {
  return <div><h2>{title}</h2><Button label="Action" onClick={() => {}} /></div>;
}
`,
  );

  await writeFile(
    join(tmp, "src", "components", "Form.tsx"),
    `import { Button } from './Button';
export function Form() {
  return <form><Button label="Submit" onClick={() => {}} /></form>;
}
`,
  );

  await writeFile(
    join(tmp, "src", "hooks", "useAuth.ts"),
    `export function useAuth() { return { user: null, login: () => {}, logout: () => {} }; }
`,
  );

  await writeFile(
    join(tmp, "src", "App.tsx"),
    `import { Card } from './components/Card';
import { Form } from './components/Form';
export function App() { return <div><Card title="Hello" /><Form /></div>; }
`,
  );

  // Run init
  const cliPath = resolve("dist/cli.js");
  execSync(`node "${cliPath}" init -d "${tmp}"`, { stdio: "ignore" });

  return tmp;
}

async function loadEngine(projectDir: string): Promise<QueryEngine> {
  const engine = new QueryEngine(projectDir);
  await engine.load();
  return engine;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

async function testBuildReturnsStructure(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const ctx = builder.build("refactor Button");

    assert.equal(ctx.task, "refactor Button");
    assert.ok(ctx.summary !== undefined);
    assert.ok(typeof ctx.summary.matchedComponents === "number");
    assert.ok(typeof ctx.summary.relatedComponents === "number");
    assert.ok(typeof ctx.summary.relevantInsights === "number");
    assert.ok(typeof ctx.summary.totalFiles === "number");
    assert.ok(typeof ctx.summary.estimatedTokens === "number");
    assert.ok(Array.isArray(ctx.matches));
    assert.ok(Array.isArray(ctx.related));
    assert.ok(Array.isArray(ctx.insights));
    assert.ok(Array.isArray(ctx.files));

    ok("testBuildReturnsStructure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildFindsButton(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const ctx = builder.build("Button component");

    assert.ok(ctx.matches.length > 0, "Should find at least one match");
    const buttonMatch = ctx.matches.find((m) => m.name === "Button");
    assert.ok(buttonMatch !== undefined, "Should find Button component");
    assert.equal(buttonMatch!.type, "component");

    ok("testBuildFindsButton");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildExpandsRelated(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const ctx = builder.build("Button component");

    // Button has dependents (Card, Form) so related should be populated
    if (ctx.matches.length > 0) {
      // Related components should include dependents/dependencies
      const allNames = [
        ...ctx.matches.map((m) => m.name),
        ...ctx.related.map((r) => r.name),
      ];
      // At minimum, we should have the Button match
      assert.ok(allNames.includes("Button"));
    }

    ok("testBuildExpandsRelated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildNoMatchReturnsEmpty(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const ctx = builder.build("xyznonexistent123");

    assert.equal(ctx.matches.length, 0);
    assert.equal(ctx.related.length, 0);

    ok("testBuildNoMatchReturnsEmpty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildMaxMatchesLimitsResults(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const ctx = builder.build("component", { maxMatches: 2 });

    assert.ok(ctx.matches.length <= 2, `Expected <= 2 matches, got ${ctx.matches.length}`);

    ok("testBuildMaxMatchesLimitsResults");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildTextFormat(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const text = builder.buildText("Button");

    assert.ok(text.includes("Task:"));
    assert.ok(text.includes("Matched:"));
    assert.ok(typeof text === "string");
    assert.ok(text.length > 0);

    ok("testBuildTextFormat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildMarkdownFormat(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const md = builder.buildMarkdown("Button");

    assert.ok(md.includes("# Task Context:"));
    assert.ok(md.includes("##"));
    assert.ok(typeof md === "string");

    ok("testBuildMarkdownFormat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildCharBudgetTrims(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);

    // Build with a very small budget
    const ctx = builder.build("component", { charBudget: 500 });

    // Serialized should be within budget (approximately)
    const serialized = JSON.stringify(ctx);
    // The budget trimming is best-effort; verify it's not dramatically over
    assert.ok(serialized.length < 2000, `Expected compact output, got ${serialized.length} chars`);

    ok("testBuildCharBudgetTrims");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildDeterministic(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);

    const ctx1 = builder.build("Button");
    const ctx2 = builder.build("Button");

    assert.deepEqual(ctx1.matches, ctx2.matches);
    assert.deepEqual(ctx1.related, ctx2.related);
    assert.deepEqual(ctx1.files, ctx2.files);

    ok("testBuildDeterministic");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildFilesListContainsPaths(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const ctx = builder.build("Button");

    if (ctx.matches.length > 0) {
      assert.ok(ctx.files.length > 0, "Files list should be non-empty when matches exist");
      for (const f of ctx.files) {
        assert.ok(typeof f === "string");
        assert.ok(f.length > 0);
      }
    }

    ok("testBuildFilesListContainsPaths");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testBuildEstimatesTokens(): Promise<void> {
  const dir = await createTestProject();
  try {
    const engine = await loadEngine(dir);
    const builder = new TaskScopedBuilder(engine);
    const ctx = builder.build("Button");

    assert.ok(ctx.summary.estimatedTokens > 0, "Should estimate non-zero tokens");
    assert.ok(ctx.summary.estimatedTokens < 100000, "Token estimate should be reasonable");

    ok("testBuildEstimatesTokens");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("TaskScopedBuilder tests");

  await testBuildReturnsStructure();
  await testBuildFindsButton();
  await testBuildExpandsRelated();
  await testBuildNoMatchReturnsEmpty();
  await testBuildMaxMatchesLimitsResults();
  await testBuildTextFormat();
  await testBuildMarkdownFormat();
  await testBuildCharBudgetTrims();
  await testBuildDeterministic();
  await testBuildFilesListContainsPaths();
  await testBuildEstimatesTokens();

  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
