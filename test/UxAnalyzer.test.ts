import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { UxAnalyzer } from "../src/analyzers/UxAnalyzer.js";
import { FileDiscovery } from "../src/core/FileDiscovery.js";
import type { CacheAccessor, DiscoveredFile, CacheKey, FileHash, AnalyzerId } from "../src/types/index.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

function createNoopCache(): CacheAccessor {
  return {
    get: () => undefined,
    set: () => {},
    has: () => false,
    invalidate: () => {},
    invalidateByAnalyzer: () => {},
  };
}

async function createProject(files: Record<string, string>): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-ux-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(tmp, name);
    const dir = join(filePath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content);
  }
  return tmp;
}

async function discoverFiles(rootPath: string): Promise<DiscoveredFile[]> {
  const discovery = new FileDiscovery({ rootPath });
  return discovery.discover();
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

async function testUxAnalyzerInterface(): Promise<void> {
  const analyzer = new UxAnalyzer();
  assert.equal(analyzer.name, "ux");
  assert.equal(analyzer.version, "1.1.0");
  assert.ok(analyzer.capabilities.length > 0);
  assert.deepEqual([...analyzer.dependencies!], []);

  ok("testUxAnalyzerInterface");
}

async function testUxAnalyzerFileFilter(): Promise<void> {
  const analyzer = new UxAnalyzer();

  assert.equal(analyzer.fileFilter({ relativePath: "a.tsx", extension: "tsx" } as DiscoveredFile), true);
  assert.equal(analyzer.fileFilter({ relativePath: "a.jsx", extension: "jsx" } as DiscoveredFile), true);
  assert.equal(analyzer.fileFilter({ relativePath: "a.vue", extension: "vue" } as DiscoveredFile), true);
  assert.equal(analyzer.fileFilter({ relativePath: "a.svelte", extension: "svelte" } as DiscoveredFile), true);
  assert.equal(analyzer.fileFilter({ relativePath: "a.css", extension: "css" } as DiscoveredFile), true);
  assert.equal(analyzer.fileFilter({ relativePath: "a.scss", extension: "scss" } as DiscoveredFile), true);
  assert.equal(analyzer.fileFilter({ relativePath: "a.ts", extension: "ts" } as DiscoveredFile), true);
  assert.equal(analyzer.fileFilter({ relativePath: "a.json", extension: "json" } as DiscoveredFile), false);
  assert.equal(analyzer.fileFilter({ relativePath: "a.md", extension: "md" } as DiscoveredFile), false);

  ok("testUxAnalyzerFileFilter");
}

async function testUxAnalyzerDetectsAria(): Promise<void> {
  const dir = await createProject({
    "src/Button.tsx": `
export function Button() {
  return <button aria-label="Click me" role="button">Click</button>;
}
`,
  });

  try {
    const analyzer = new UxAnalyzer();
    const files = await discoverFiles(dir);
    const filtered = files.filter((f) => analyzer.fileFilter(f));

    const output = await analyzer.analyze({
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    assert.ok(output.patterns.length > 0, "Should produce patterns");

    // Find the summary pattern
    const summary = output.patterns.find((p) => p.name === "ux-summary");
    assert.ok(summary !== undefined, "Should have ux-summary pattern");

    const meta = summary!.metadata;
    assert.ok((meta["ariaAttributeCount"] as number) > 0, "Should detect aria attributes");
    assert.ok((meta["roleAttributeCount"] as number) > 0, "Should detect role attributes");

    ok("testUxAnalyzerDetectsAria");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerDetectsErrorStates(): Promise<void> {
  const dir = await createProject({
    "src/DataView.tsx": `
export function DataView() {
  const { data, isLoading, isError } = useFetch('/api/data');
  if (isLoading) return <Skeleton />;
  if (isError) return <ErrorBoundary />;
  return <div>{data}</div>;
}
`,
  });

  try {
    const analyzer = new UxAnalyzer();
    const files = await discoverFiles(dir);
    const filtered = files.filter((f) => analyzer.fileFilter(f));

    const output = await analyzer.analyze({
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    const summary = output.patterns.find((p) => p.name === "ux-summary");
    assert.ok(summary !== undefined);
    assert.ok((summary!.metadata["filesWithErrorHandling"] as number) > 0, "Should detect error handling");
    assert.ok((summary!.metadata["filesWithLoadingStates"] as number) > 0, "Should detect loading states");

    ok("testUxAnalyzerDetectsErrorStates");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerDetectsResponsive(): Promise<void> {
  const dir = await createProject({
    "src/Layout.css": `
.container {
  width: 100%;
}
@media (min-width: 768px) {
  .container { width: 720px; }
}
@media (max-width: 480px) {
  .container { width: 100%; }
}
`,
    "src/Card.tsx": `
export function Card() {
  return <div className="sm:p-4 md:p-8 lg:p-12">Card</div>;
}
`,
  });

  try {
    const analyzer = new UxAnalyzer();
    const files = await discoverFiles(dir);
    const filtered = files.filter((f) => analyzer.fileFilter(f));

    const output = await analyzer.analyze({
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    const summary = output.patterns.find((p) => p.name === "ux-summary");
    assert.ok(summary !== undefined);

    const mediaQueries = summary!.metadata["filesWithMediaQueries"] as number;
    const responsive = summary!.metadata["filesWithResponsiveClasses"] as number;
    assert.ok(mediaQueries > 0 || responsive > 0, "Should detect responsive patterns");

    ok("testUxAnalyzerDetectsResponsive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerDetectsNavigation(): Promise<void> {
  const dir = await createProject({
    "src/Nav.tsx": `
import { Link } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
export function Nav() {
  const navigate = useNavigate();
  return <nav><Link to="/">Home</Link></nav>;
}
`,
  });

  try {
    const analyzer = new UxAnalyzer();
    const files = await discoverFiles(dir);
    const filtered = files.filter((f) => analyzer.fileFilter(f));

    const output = await analyzer.analyze({
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    const summary = output.patterns.find((p) => p.name === "ux-summary");
    assert.ok(summary !== undefined);
    assert.ok((summary!.metadata["filesWithNavigation"] as number) > 0, "Should detect navigation");

    ok("testUxAnalyzerDetectsNavigation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerDetectsComponentPrefixes(): Promise<void> {
  const dir = await createProject({
    "src/UiButton.tsx": `export function UiButton() { return <button>Click</button>; }`,
    "src/UiInput.tsx": `export function UiInput() { return <input />; }`,
    "src/AppHeader.tsx": `export function AppHeader() { return <header>Header</header>; }`,
  });

  try {
    const analyzer = new UxAnalyzer();
    const files = await discoverFiles(dir);
    const filtered = files.filter((f) => analyzer.fileFilter(f));

    const output = await analyzer.analyze({
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    const summary = output.patterns.find((p) => p.name === "ux-summary");
    assert.ok(summary !== undefined);

    const prefixes = summary!.metadata["componentPrefixes"] as Record<string, number>;
    assert.ok(typeof prefixes === "object");
    assert.ok(Object.keys(prefixes).length > 0, "Should detect component prefixes");

    ok("testUxAnalyzerDetectsComponentPrefixes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerEmptyProject(): Promise<void> {
  const dir = await createProject({});

  try {
    const analyzer = new UxAnalyzer();

    const output = await analyzer.analyze({
      rootPath: dir,
      files: [],
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    assert.ok(output.patterns.length >= 1, "Should always produce summary pattern");
    assert.ok(output.hash.length > 0);
    assert.equal(output.stats.totalFiles, 0);

    ok("testUxAnalyzerEmptyProject");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerDeterministic(): Promise<void> {
  const dir = await createProject({
    "src/Button.tsx": `
export function Button() {
  return <button aria-label="Click" role="button">Click</button>;
}
`,
    "src/Form.tsx": `
export function Form() {
  const { isLoading } = useData();
  if (isLoading) return <div>Loading...</div>;
  return <form>Form</form>;
}
`,
  });

  try {
    const analyzer = new UxAnalyzer();
    const files = await discoverFiles(dir);
    const filtered = files.filter((f) => analyzer.fileFilter(f));

    const context = {
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0" as const,
    };

    const out1 = await analyzer.analyze(context);
    const out2 = await analyzer.analyze(context);

    assert.equal(out1.hash, out2.hash, "Hash should be deterministic");
    assert.equal(out1.patterns.length, out2.patterns.length);

    ok("testUxAnalyzerDeterministic");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerDiagnosticsForLowCoverage(): Promise<void> {
  // Create many component files with no ARIA
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) {
    files[`src/Component${i}.tsx`] = `export function Component${i}() { return <div>Component ${i}</div>; }`;
  }

  const dir = await createProject(files);

  try {
    const analyzer = new UxAnalyzer();
    const discovered = await discoverFiles(dir);
    const filtered = discovered.filter((f) => analyzer.fileFilter(f));

    const output = await analyzer.analyze({
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    // Should have diagnostics about low coverage
    const uxDiags = output.diagnostics.filter((d) => d.message.startsWith("UX"));
    assert.ok(uxDiags.length > 0, "Should produce UX diagnostics for low coverage");

    ok("testUxAnalyzerDiagnosticsForLowCoverage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerEmptyStates(): Promise<void> {
  const dir = await createProject({
    "src/List.tsx": `
export function List({ items }: { items: unknown[] }) {
  if (items.length === 0) return <EmptyState />;
  return <ul>{items.map((i, idx) => <li key={idx}>{String(i)}</li>)}</ul>;
}
`,
  });

  try {
    const analyzer = new UxAnalyzer();
    const files = await discoverFiles(dir);
    const filtered = files.filter((f) => analyzer.fileFilter(f));

    const output = await analyzer.analyze({
      rootPath: dir,
      files: filtered,
      cache: createNoopCache(),
      previousResults: new Map(),
      dependencyOutputs: new Map(),
      schemaVersion: "2.0",
    });

    const summary = output.patterns.find((p) => p.name === "ux-summary");
    assert.ok(summary !== undefined);
    assert.ok((summary!.metadata["filesWithEmptyStates"] as number) > 0, "Should detect empty states");

    ok("testUxAnalyzerEmptyStates");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUxAnalyzerIntegrationWithInit(): Promise<void> {
  const dir = await createProject({
    "src/Button.tsx": `
export function Button() {
  return <button aria-label="Click" role="button">Click</button>;
}
`,
    "src/App.tsx": `
import { Button } from './Button';
export function App() { return <Button />; }
`,
  });

  try {
    // Run full init pipeline
    const cliPath = resolve("dist/cli.js");
    execSync(`node "${cliPath}" init -d "${dir}"`, { stdio: "ignore" });

    // Verify the UX analyzer ran (check for ux patterns in index)
    const { readFile } = await import("node:fs/promises");
    const indexJson = await readFile(join(dir, ".uiq", "index.json"), "utf-8");
    const index = JSON.parse(indexJson) as { entries: Record<string, unknown> };

    const uxEntries = Object.keys(index.entries).filter((k) => k.includes(":ux:") || k.includes("ux-summary"));
    assert.ok(uxEntries.length > 0, "Init should include UX analyzer patterns in index");

    ok("testUxAnalyzerIntegrationWithInit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// AST-specific tests
// -----------------------------------------------------------------------------

async function testAstDetectsAriaMoreAccurately(): Promise<void> {
  // The string "aria-label" in a comment should NOT be detected by AST,
  // but genuine JSX aria-label attributes should be detected.
  const dir = await createProject({
    "src/AccurateAria.tsx": `
// This component uses aria-label for accessibility (comment — not a real attr)
// Also has "aria-hidden" in a string literal: const text = "aria-hidden note";
export function AccurateAria() {
  const note = "aria-describedby is just a string here";
  return (
    <div>
      <button aria-label="Submit form" aria-expanded={isOpen}>Click</button>
      <input role="searchbox" aria-required={true} />
    </div>
  );
}
`,
  });

  try {
    const files = await discoverFiles(dir);
    const analyzer = new UxAnalyzer();
    const output = await analyzer.analyze({
      rootPath: dir,
      files,
      cache: createNoopCache(),
      prior: new Map(),
    });

    // AST should find exactly 3 aria attrs (aria-label, aria-expanded, aria-required)
    // and 1 role attr (role="searchbox")
    // It should NOT false-positive on the comment or string literal
    const filePattern = output.patterns.find((p) => p.name.includes("AccurateAria"));
    assert.ok(filePattern, "Should produce a pattern for AccurateAria");
    assert.equal(filePattern!.metadata["ariaCount"], 3, "Should detect exactly 3 ARIA JSX attributes");
    assert.equal(filePattern!.metadata["roleCount"], 1, "Should detect exactly 1 role JSX attribute");

    ok("testAstDetectsAriaMoreAccurately");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testAstDetectsErrorBoundaryComponent(): Promise<void> {
  const dir = await createProject({
    "src/SafePage.tsx": `
import { ErrorBoundary } from "react-error-boundary";

export function SafePage() {
  return (
    <ErrorBoundary fallback={<div>Something went wrong</div>}>
      <Suspense fallback={<Skeleton />}>
        <MainContent />
      </Suspense>
    </ErrorBoundary>
  );
}
`,
  });

  try {
    const files = await discoverFiles(dir);
    const analyzer = new UxAnalyzer();
    const output = await analyzer.analyze({
      rootPath: dir,
      files,
      cache: createNoopCache(),
      prior: new Map(),
    });

    const filePattern = output.patterns.find((p) => p.name.includes("SafePage"));
    assert.ok(filePattern, "Should produce a pattern for SafePage");
    assert.equal(filePattern!.metadata["hasErrorHandling"], true, "AST should detect ErrorBoundary JSX element");
    assert.equal(filePattern!.metadata["hasLoadingState"], true, "AST should detect Suspense/Skeleton JSX elements");

    ok("testAstDetectsErrorBoundaryComponent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testHybridRegexForCssFiles(): Promise<void> {
  // CSS files should still use regex (no AST) and detect media queries
  const dir = await createProject({
    "src/responsive.css": `
.container {
  max-width: 1200px;
  margin: 0 auto;
}

@media (max-width: 768px) {
  .container {
    max-width: 100%;
    padding: 0 16px;
  }
}

@media (min-width: 1024px) {
  .sidebar {
    display: block;
  }
}
`,
  });

  try {
    const files = await discoverFiles(dir);
    const analyzer = new UxAnalyzer();
    const output = await analyzer.analyze({
      rootPath: dir,
      files,
      cache: createNoopCache(),
      prior: new Map(),
    });

    // CSS files use regex fallback, should detect media queries and breakpoints
    const summary = output.patterns.find((p) => p.name === "ux-summary");
    assert.ok(summary, "Should have ux-summary pattern");
    const mqCount = Number(summary!.metadata["filesWithMediaQueries"]);
    assert.ok(mqCount >= 1, "Should detect media queries in CSS via regex");

    ok("testHybridRegexForCssFiles");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("UxAnalyzer tests");

  await testUxAnalyzerInterface();
  await testUxAnalyzerFileFilter();
  await testUxAnalyzerDetectsAria();
  await testUxAnalyzerDetectsErrorStates();
  await testUxAnalyzerDetectsResponsive();
  await testUxAnalyzerDetectsNavigation();
  await testUxAnalyzerDetectsComponentPrefixes();
  await testUxAnalyzerEmptyProject();
  await testUxAnalyzerDeterministic();
  await testUxAnalyzerDiagnosticsForLowCoverage();
  await testUxAnalyzerEmptyStates();
  await testUxAnalyzerIntegrationWithInit();
  await testAstDetectsAriaMoreAccurately();
  await testAstDetectsErrorBoundaryComponent();
  await testHybridRegexForCssFiles();

  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
