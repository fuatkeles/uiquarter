import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ContextBuilder } from "../../src/context/ContextBuilder.js";
import type { ProjectContext } from "../../src/context/ContextBuilder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function makeTestDir(): string {
  return join(
    tmpdir(),
    "uiq-ctx-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
  );
}

async function createProject(): Promise<string> {
  const root = makeTestDir();
  const srcDir = join(root, "src");
  const compDir = join(srcDir, "components");
  await mkdir(compDir, { recursive: true });

  await writeFile(
    join(srcDir, "App.tsx"),
    `import { Button } from "./components/Button";\nimport { Modal } from "./components/Modal";\nexport default function App() { return <div><Button /><Modal /></div>; }\n`,
  );
  await writeFile(
    join(compDir, "Button.tsx"),
    `export function Button() { return <button>Click</button>; }\n`,
  );
  await writeFile(
    join(compDir, "Modal.tsx"),
    `import { Button } from "./Button";\nexport function Modal() { return <div><Button /></div>; }\n`,
  );

  execSync("node dist/cli.js init -d " + JSON.stringify(root), {
    cwd: join(__dirname, "..", ".."),
    stdio: "pipe",
  });

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testLoadSuccess() {
  const root = await createProject();
  try {
    const builder = new ContextBuilder(root);
    await builder.load();
    // Should not throw
    console.log("PASS: testLoadSuccess");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testBuildBeforeLoadThrows() {
  const builder = new ContextBuilder("/nonexistent");
  let threw = false;
  try {
    builder.buildProjectContext();
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes("not loaded"),
      `Should mention 'not loaded', got: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assert(threw, "buildProjectContext should throw before load");
  console.log("PASS: testBuildBeforeLoadThrows");
}

async function testLoadMissingIndexThrows() {
  const root = makeTestDir();
  await mkdir(root, { recursive: true });
  const builder = new ContextBuilder(root);
  let threw = false;
  try {
    await builder.load();
  } catch {
    threw = true;
  }
  assert(threw, "load should throw when .uiq is missing");
  await rm(root, { recursive: true, force: true }).catch(() => {});
  console.log("PASS: testLoadMissingIndexThrows");
}

async function testBuildProjectContextShape() {
  const root = await createProject();
  try {
    const builder = new ContextBuilder(root);
    await builder.load();
    const ctx = builder.buildProjectContext();

    // Summary
    assert(typeof ctx.summary.totalComponents === "number", "totalComponents should be a number");
    assert(typeof ctx.summary.totalInsights === "number", "totalInsights should be a number");
    assert(typeof ctx.summary.hubCount === "number", "hubCount should be a number");
    assert(typeof ctx.summary.deepChainCount === "number", "deepChainCount should be a number");

    // Arrays exist
    assert(Array.isArray(ctx.components), "components should be an array");
    assert(Array.isArray(ctx.insights), "insights should be an array");
    assert(Array.isArray(ctx.deepChains), "deepChains should be an array");
    assert(Array.isArray(ctx.hubs), "hubs should be an array");

    console.log("PASS: testBuildProjectContextShape");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testComponentContextFields() {
  const root = await createProject();
  try {
    const builder = new ContextBuilder(root);
    await builder.load();
    const ctx = builder.buildProjectContext();

    if (ctx.components.length > 0) {
      const comp = ctx.components[0]!;
      assert(typeof comp.name === "string" && comp.name.length > 0, "Component should have a name");
      assert(typeof comp.filePath === "string" && comp.filePath.length > 0, "Component should have a filePath");
      assert(typeof comp.dependencyCount === "number", "dependencyCount should be a number");
      assert(typeof comp.dependentCount === "number", "dependentCount should be a number");
      assert(typeof comp.isHub === "boolean", "isHub should be a boolean");
      assert(typeof comp.isOrphan === "boolean", "isOrphan should be a boolean");
    }

    console.log("PASS: testComponentContextFields");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testInsightContextFields() {
  const root = await createProject();
  try {
    const builder = new ContextBuilder(root);
    await builder.load();
    const ctx = builder.buildProjectContext();

    for (const insight of ctx.insights) {
      assert(typeof insight.type === "string", "Insight type should be a string");
      assert(typeof insight.severity === "string", "Insight severity should be a string");
      assert(typeof insight.confidence === "number", "Insight confidence should be a number");
      assert(insight.confidence >= 0 && insight.confidence <= 1, "Confidence should be between 0 and 1");
    }

    console.log("PASS: testInsightContextFields");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testComponentsSorted() {
  const root = await createProject();
  try {
    const builder = new ContextBuilder(root);
    await builder.load();
    const ctx = builder.buildProjectContext();

    for (let i = 1; i < ctx.components.length; i++) {
      const prev = ctx.components[i - 1]!.name;
      const curr = ctx.components[i]!.name;
      assert(prev <= curr, `Components should be sorted: "${prev}" should come before "${curr}"`);
    }

    console.log("PASS: testComponentsSorted");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testDeterminism() {
  const root = await createProject();
  try {
    const builder = new ContextBuilder(root);
    await builder.load();
    const ctx1 = builder.buildProjectContext();
    const ctx2 = builder.buildProjectContext();

    assert(
      JSON.stringify(ctx1) === JSON.stringify(ctx2),
      "Two consecutive buildProjectContext calls should be identical",
    );

    console.log("PASS: testDeterminism");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testHubCountMatchesSummary() {
  const root = await createProject();
  try {
    const builder = new ContextBuilder(root);
    await builder.load();
    const ctx = builder.buildProjectContext();

    assert(
      ctx.summary.hubCount === ctx.hubs.length,
      `Summary hubCount (${ctx.summary.hubCount}) should equal hubs.length (${ctx.hubs.length})`,
    );

    assert(
      ctx.summary.deepChainCount === ctx.deepChains.length,
      `Summary deepChainCount (${ctx.summary.deepChainCount}) should equal deepChains.length (${ctx.deepChains.length})`,
    );

    console.log("PASS: testHubCountMatchesSummary");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log("ContextBuilder tests\n");

  await testLoadSuccess();
  await testBuildBeforeLoadThrows();
  await testLoadMissingIndexThrows();
  await testBuildProjectContextShape();
  await testComponentContextFields();
  await testInsightContextFields();
  await testComponentsSorted();
  await testDeterminism();
  await testHubCountMatchesSummary();

  console.log("\n9 tests: 9 passed, 0 failed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
