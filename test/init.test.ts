import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileDiscovery } from "../src/core/FileDiscovery.js";
import { AnalyzerOrchestrator } from "../src/core/AnalyzerOrchestrator.js";
import { normalizeOutput } from "../src/core/normalizer.js";
import { CacheLayer } from "../src/cache/CacheLayer.js";
import { IntelligenceIndexer } from "../src/indexer/IntelligenceIndexer.js";
import { StructureAnalyzer } from "../src/analyzers/stubs.js";
import { ImportAnalyzer } from "../src/analyzers/ImportAnalyzer.js";
import { FileStructureAnalyzer } from "../src/analyzers/FileStructureAnalyzer.js";
import type { Analyzer } from "../src/types/index.js";
import type { AnalyzerId, AnalyzerOutput, CacheAccessor } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const ROOT = join(tmpdir(), "uiq-init-test-" + Date.now());

async function freshProject(files: Record<string, string>): Promise<string> {
  const dir = join(
    ROOT,
    String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
  );
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return dir;
}

/** Run the full pipeline programmatically (same as CLI init without console output) */
async function runPipeline(
  rootPath: string,
  opts?: { noCache?: boolean; analyzers?: Analyzer[] },
): Promise<{
  files: import("../src/types/index.js").DiscoveredFile[];
  result: import("../src/core/AnalyzerOrchestrator.js").OrchestratorResult;
  normalized: Map<string, AnalyzerOutput>;
  index: import("../src/types/index.js").IntelligenceIndex;
  cache?: CacheLayer;
}> {
  // 1. Discover
  const discovery = new FileDiscovery({ rootPath });
  const files = await discovery.discover();

  // 2. Cache
  let cache: CacheLayer | undefined;
  if (!opts?.noCache) {
    cache = await CacheLayer.create({ rootPath });
    for (const f of files) cache.setFileHash(f.relativePath, f.hash);
  }

  // 3. Analyzers
  const analyzers = opts?.analyzers ?? [new StructureAnalyzer()];
  const orchestrator = new AnalyzerOrchestrator(analyzers);

  const accessor: CacheAccessor = cache
    ? cache.createAccessor("init@0.1.0" as AnalyzerId, "0.1.0")
    : { get: () => undefined, set: () => {}, has: () => false, invalidate: () => {}, invalidateByAnalyzer: () => {} };

  const result = await orchestrator.run({ rootPath, files, cache: accessor });

  // 4. Normalize
  const normalized = new Map<string, AnalyzerOutput>();
  for (const [name, output] of result.outputs) {
    normalized.set(name, normalizeOutput(output));
  }

  // 5. Cache flush
  if (cache) {
    for (const [name, output] of normalized) {
      cache.setAnalyzerResult(name, output);
    }
    await cache.flush();
  }

  // 6. Index
  const indexer = new IntelligenceIndexer({ rootPath });
  const index = await indexer.buildAndWrite(normalized);

  return { files, result, normalized, index, cache };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testEmptyDirectory() {
  const root = await freshProject({});
  const { index } = await runPipeline(root);

  assert(index.entries.size === 0, "Empty dir should produce 0 patterns");
  assert(index.edges.length === 0, "Empty dir should produce 0 edges");
  assert(index.stats.totalPatterns === 0, "totalPatterns should be 0");

  // .uiq/ should still be created with valid files
  const uiqFiles = await readdir(join(root, ".uiq"));
  assert(uiqFiles.includes("index.json"), "Should create index.json");
  assert(uiqFiles.includes("meta.json"), "Should create meta.json");
  assert(uiqFiles.includes("patterns"), "Should create patterns/");

  console.log("PASS: testEmptyDirectory");
}

async function testOutputDirectoryStructure() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
  });

  await runPipeline(root);

  const uiqDir = join(root, ".uiq");
  const uiqFiles = await readdir(uiqDir);
  assert(uiqFiles.includes("index.json"), "index.json");
  assert(uiqFiles.includes("meta.json"), "meta.json");
  assert(uiqFiles.includes("patterns"), "patterns/");
  assert(uiqFiles.includes("cache"), "cache/ (from CacheLayer)");

  const meta = JSON.parse(await readFile(join(uiqDir, "meta.json"), "utf-8"));
  assert(typeof meta.intelligenceHash === "string", "meta has intelligenceHash");
  assert(typeof meta.generatedAt === "string", "meta has generatedAt");
  assert(meta.toolVersion === "0.1.0", "meta has toolVersion");
  assert(meta.schemaVersion === 1, "meta has schemaVersion");

  console.log("PASS: testOutputDirectoryStructure");
}

async function testDiscoveryAndPatternCreation() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "src/utils.ts": "export function formatDate() {}",
    "src/Card.vue": "<template><div/></template>",
  });

  const { files, index } = await runPipeline(root);

  assert(files.length === 3, `Expected 3 files, got ${files.length}`);
  assert(index.entries.size === 3, `Expected 3 patterns, got ${index.entries.size}`);

  // Pattern files should exist
  const patternFiles = await readdir(join(root, ".uiq/patterns"));
  assert(patternFiles.length === 3, `Expected 3 pattern files, got ${patternFiles.length}`);

  console.log("PASS: testDiscoveryAndPatternCreation");
}

async function testStubAnalyzerPatternTypes() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "src/App.jsx": "export default function App() {}",
    "src/utils.ts": "export function helper() {}",
    "lib/index.js": "module.exports = {}",
    "src/Card.vue": "<template/>",
    "src/Nav.svelte": "<script/>",
  });

  const { index } = await runPipeline(root);

  // Check types
  for (const pattern of index.entries.values()) {
    if (["tsx", "jsx", "vue", "svelte"].some((ext) => pattern.filePath.endsWith(`.${ext}`))) {
      assert(pattern.type === "component", `${pattern.filePath} should be component, got ${pattern.type}`);
    } else {
      assert(pattern.type === "utility", `${pattern.filePath} should be utility, got ${pattern.type}`);
    }
  }

  console.log("PASS: testStubAnalyzerPatternTypes");
}

async function testFrameworkDetection() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "src/Card.vue": "<template/>",
    "src/Nav.svelte": "<script/>",
    "src/utils.ts": "export function helper() {}",
  });

  const { index } = await runPipeline(root);

  const frameworks = new Map<string, string>();
  for (const pattern of index.entries.values()) {
    frameworks.set(pattern.filePath, pattern.framework);
  }

  assert(frameworks.get("src/Button.tsx") === "react", "tsx → react");
  assert(frameworks.get("src/Card.vue") === "vue", "vue → vue");
  assert(frameworks.get("src/Nav.svelte") === "svelte", "svelte → svelte");
  assert(frameworks.get("src/utils.ts") === "react", "ts → react (default)");

  console.log("PASS: testFrameworkDetection");
}

async function testDependencyOrdering() {
  const root = await freshProject({
    "src/App.tsx": "export default function App() {}",
  });

  // ImportAnalyzer (no deps) → FileStructureAnalyzer (depends on "import")
  const chainedAnalyzers = [
    new ImportAnalyzer(),
    new FileStructureAnalyzer(),
  ];
  const { result } = await runPipeline(root, { analyzers: chainedAnalyzers });

  // Both analyzers should have run successfully
  assert(result.errors.length === 0, `No errors expected, got ${result.errors.length}`);
  assert(result.skipped.length === 0, `No skips expected, got ${result.skipped.length}`);
  assert(result.outputs.has("import"), "import analyzer should have output");
  assert(result.outputs.has("file-structure"), "file-structure analyzer should have output");

  // FileStructureAnalyzer always produces at least a root directory + conventions pattern
  assert(
    result.outputs.get("file-structure")!.patterns.length >= 1,
    "file-structure should produce at least 1 pattern",
  );

  console.log("PASS: testDependencyOrdering");
}

async function testNormalizationApplied() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
  });

  const { normalized } = await runPipeline(root);
  const structureOutput = normalized.get("structure")!;

  assert(structureOutput !== undefined, "structure output should exist");

  for (const pattern of structureOutput.patterns) {
    // Paths should use forward slashes
    assert(!pattern.filePath.includes("\\"), `Path should use forward slashes: ${pattern.filePath}`);
    // Name should be trimmed
    assert(pattern.name === pattern.name.trim(), "Name should be trimmed");
    // Framework should be lowercase
    assert(
      pattern.framework === pattern.framework.toLowerCase(),
      "Framework should be lowercase",
    );
  }

  // Hash should be recomputed (64-char hex)
  assert(
    typeof structureOutput.hash === "string" &&
    (structureOutput.hash as string).length === 64,
    "Hash should be 64-char hex after normalization",
  );

  console.log("PASS: testNormalizationApplied");
}

async function testCachePopulated() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "src/utils.ts": "export function helper() {}",
  });

  const { cache } = await runPipeline(root);
  assert(cache !== undefined, "Cache should exist");

  // File hashes should be stored
  assert(
    cache!.getFileHash("src/Button.tsx") !== undefined,
    "Button.tsx hash should be cached",
  );
  assert(
    cache!.getFileHash("src/utils.ts") !== undefined,
    "utils.ts hash should be cached",
  );

  // Analyzer results should be stored
  assert(
    cache!.getAnalyzerResult("structure") !== undefined,
    "structure result should be cached",
  );

  // Cache should be persisted to disk
  const cacheDir = join(root, ".uiq/cache");
  const cacheFiles = await readdir(cacheDir);
  assert(cacheFiles.includes("meta.json"), "cache meta.json should exist");
  assert(cacheFiles.includes("filehashes.json"), "filehashes.json should exist");
  assert(cacheFiles.includes("analyzer-results.json"), "analyzer-results.json should exist");

  console.log("PASS: testCachePopulated");
}

async function testNoCacheMode() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
  });

  const { index, cache } = await runPipeline(root, { noCache: true });

  assert(cache === undefined, "Cache should be undefined in no-cache mode");
  assert(index.entries.size === 1, "Should still produce patterns");

  // .uiq/ should exist (from indexer) but no cache/ subdir
  const uiqFiles = await readdir(join(root, ".uiq"));
  assert(uiqFiles.includes("index.json"), "index.json should exist");
  assert(!uiqFiles.includes("cache"), "cache/ should NOT exist in no-cache mode");

  console.log("PASS: testNoCacheMode");
}

async function testIndexJsonContent() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "src/Card.vue": "<template/>",
  });

  const { index } = await runPipeline(root);

  // Read and verify index.json
  const raw = await readFile(join(root, ".uiq/index.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  assert(parsed["buildNumber"] === 1, "buildNumber should be 1");
  assert(typeof parsed["compositeHash"] === "string", "compositeHash should exist");

  const entries = parsed["entries"] as Record<string, unknown>;
  assert(Object.keys(entries).length === 2, "Should have 2 entries in index.json");

  const stats = parsed["stats"] as Record<string, unknown>;
  assert(stats["totalPatterns"] === 2, "stats.totalPatterns should be 2");
  assert(stats["totalFiles"] === 2, "stats.totalFiles should be 2");

  // Verify intelligenceHash in meta.json matches index.json
  const metaRaw = await readFile(join(root, ".uiq/meta.json"), "utf-8");
  const meta = JSON.parse(metaRaw) as Record<string, unknown>;
  const expectedHash = createHash("sha256").update(raw).digest("hex");
  assert(
    meta["intelligenceHash"] === expectedHash,
    "intelligenceHash should match SHA-256 of index.json",
  );

  console.log("PASS: testIndexJsonContent");
}

async function testIgnoredFilesExcluded() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "node_modules/react/index.js": "module.exports = {}",
    "dist/output.js": "var x = 1;",
  });

  const { files, index } = await runPipeline(root);

  // node_modules and dist should be excluded
  assert(files.length === 1, `Expected 1 file (only Button.tsx), got ${files.length}`);
  assert(index.entries.size === 1, "Only Button.tsx should produce a pattern");

  console.log("PASS: testIgnoredFilesExcluded");
}

async function testBuildNumberIncrements() {
  const root = await freshProject({
    "src/App.tsx": "export function App() {}",
  });

  const { index: idx1 } = await runPipeline(root);
  assert(idx1.buildNumber === 1, `First build should be 1, got ${idx1.buildNumber}`);

  const { index: idx2 } = await runPipeline(root);
  assert(idx2.buildNumber === 2, `Second build should be 2, got ${idx2.buildNumber}`);

  console.log("PASS: testBuildNumberIncrements");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  try {
    await testEmptyDirectory();
    await testOutputDirectoryStructure();
    await testDiscoveryAndPatternCreation();
    await testStubAnalyzerPatternTypes();
    await testFrameworkDetection();
    await testDependencyOrdering();
    await testNormalizationApplied();
    await testCachePopulated();
    await testNoCacheMode();
    await testIndexJsonContent();
    await testIgnoredFilesExcluded();
    await testBuildNumberIncrements();

    console.log("\nAll 12 tests passed.");
  } finally {
    await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
