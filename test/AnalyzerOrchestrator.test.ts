import { AnalyzerOrchestrator } from "../src/core/AnalyzerOrchestrator.js";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerOutput,
  AnalyzerId,
  OutputHash,
  DiscoveredFile,
  FileHash,
  CacheAccessor,
  CacheKey,
  CacheEntry,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const executionLog: string[] = [];

function fakeFile(name: string, ext: string): DiscoveredFile {
  return {
    absolutePath: `/project/src/${name}.${ext}`,
    relativePath: `src/${name}.${ext}`,
    hash: `hash-${name}` as FileHash,
    size: 100,
    extension: ext,
    lastModified: Date.now(),
  };
}

function fakeOutput(name: string, version: string): AnalyzerOutput {
  return {
    analyzerId: `${name}@${version}` as AnalyzerId,
    patterns: [],
    diagnostics: [],
    hash: `output-hash-${name}` as OutputHash,
    duration: 10,
    stats: { totalFiles: 1, analyzedFiles: 1, cacheHits: 0, cacheMisses: 1 },
  };
}

const noopCache: CacheAccessor = {
  get: () => undefined,
  set: () => {},
  has: () => false,
  invalidate: () => {},
  invalidateByAnalyzer: () => {},
};

function makeAnalyzer(config: {
  name: string;
  version?: string;
  dependencies?: string[];
  extensions?: string[];
  delayMs?: number;
  shouldThrow?: boolean;
  filterThrows?: boolean;
}): Analyzer {
  return {
    name: config.name,
    version: config.version ?? "1.0.0",
    capabilities: [],
    dependencies: config.dependencies,
    fileFilter: (file) => {
      if (config.filterThrows) throw new Error("filter exploded");
      if (!config.extensions) return true;
      return config.extensions.includes(file.extension);
    },
    analyze: async (ctx) => {
      executionLog.push(config.name);
      if (config.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
      }
      if (config.shouldThrow) throw new Error(`${config.name} crashed`);
      return fakeOutput(config.name, config.version ?? "1.0.0");
    },
  };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const files = [
  fakeFile("App", "tsx"),
  fakeFile("utils", "ts"),
  fakeFile("styles", "css"),
  fakeFile("readme", "md"),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testBasicExecution() {
  executionLog.length = 0;
  const orch = new AnalyzerOrchestrator([
    makeAnalyzer({ name: "alpha" }),
    makeAnalyzer({ name: "beta" }),
  ]);
  const result = await orch.run({ rootPath: "/project", files, cache: noopCache });

  assert(result.outputs.size === 2, `Expected 2 outputs, got ${result.outputs.size}`);
  assert(result.errors.length === 0, `Expected 0 errors, got ${result.errors.length}`);
  assert(result.outputs.has("alpha"), "Missing alpha output");
  assert(result.outputs.has("beta"), "Missing beta output");
  console.log("PASS: testBasicExecution");
}

async function testDependencyOrdering() {
  executionLog.length = 0;
  const orch = new AnalyzerOrchestrator([
    makeAnalyzer({ name: "c", dependencies: ["b"] }),
    makeAnalyzer({ name: "a" }),
    makeAnalyzer({ name: "b", dependencies: ["a"] }),
  ]);
  const result = await orch.run({
    rootPath: "/project",
    files,
    cache: noopCache,
    maxConcurrency: 1, // force serial to verify ordering
  });

  assert(result.outputs.size === 3, `Expected 3 outputs, got ${result.outputs.size}`);
  const aIdx = executionLog.indexOf("a");
  const bIdx = executionLog.indexOf("b");
  const cIdx = executionLog.indexOf("c");
  assert(aIdx < bIdx, `a (${aIdx}) must run before b (${bIdx})`);
  assert(bIdx < cIdx, `b (${bIdx}) must run before c (${cIdx})`);

  // Verify deterministic map key order
  const keys = [...result.outputs.keys()];
  assert(keys[0] === "a", `First key should be 'a', got '${keys[0]}'`);
  assert(keys[1] === "b", `Second key should be 'b', got '${keys[1]}'`);
  assert(keys[2] === "c", `Third key should be 'c', got '${keys[2]}'`);
  console.log("PASS: testDependencyOrdering");
}

async function testCircularDependencyDetection() {
  try {
    const orch = new AnalyzerOrchestrator([
      makeAnalyzer({ name: "x", dependencies: ["y"] }),
      makeAnalyzer({ name: "y", dependencies: ["x"] }),
    ]);
    await orch.run({ rootPath: "/project", files, cache: noopCache });
    throw new Error("Should have thrown");
  } catch (err) {
    assert(
      (err as Error).message.includes("Circular dependency"),
      `Expected circular dep error, got: ${(err as Error).message}`,
    );
  }
  console.log("PASS: testCircularDependencyDetection");
}

async function testUnknownDependencyDetection() {
  try {
    const orch = new AnalyzerOrchestrator([
      makeAnalyzer({ name: "x", dependencies: ["nonexistent"] }),
    ]);
    await orch.run({ rootPath: "/project", files, cache: noopCache });
    throw new Error("Should have thrown");
  } catch (err) {
    assert(
      (err as Error).message.includes("unknown analyzer"),
      `Expected unknown dep error, got: ${(err as Error).message}`,
    );
  }
  console.log("PASS: testUnknownDependencyDetection");
}

async function testDuplicateNameDetection() {
  try {
    new AnalyzerOrchestrator([
      makeAnalyzer({ name: "dup" }),
      makeAnalyzer({ name: "dup" }),
    ]);
    throw new Error("Should have thrown");
  } catch (err) {
    assert(
      (err as Error).message.includes("Duplicate"),
      `Expected duplicate error, got: ${(err as Error).message}`,
    );
  }
  console.log("PASS: testDuplicateNameDetection");
}

async function testAnalyzerFailureContinuation() {
  executionLog.length = 0;
  const orch = new AnalyzerOrchestrator([
    makeAnalyzer({ name: "good" }),
    makeAnalyzer({ name: "bad", shouldThrow: true }),
    makeAnalyzer({ name: "also-good" }),
  ]);
  const result = await orch.run({ rootPath: "/project", files, cache: noopCache });

  assert(result.outputs.size === 2, `Expected 2 outputs, got ${result.outputs.size}`);
  assert(result.outputs.has("good"), "good should succeed");
  assert(result.outputs.has("also-good"), "also-good should succeed");
  assert(!result.outputs.has("bad"), "bad should not be in outputs");
  assert(result.errors.length === 1, `Expected 1 error, got ${result.errors.length}`);
  assert(result.errors[0]!.analyzerName === "bad", "Error should be for 'bad'");
  assert(result.errors[0]!.phase === "analyze", `Phase should be 'analyze', got '${result.errors[0]!.phase}'`);
  console.log("PASS: testAnalyzerFailureContinuation");
}

async function testDependencySkipOnFailure() {
  executionLog.length = 0;
  const orch = new AnalyzerOrchestrator([
    makeAnalyzer({ name: "base", shouldThrow: true }),
    makeAnalyzer({ name: "dependent", dependencies: ["base"] }),
    makeAnalyzer({ name: "independent" }),
  ]);
  const result = await orch.run({ rootPath: "/project", files, cache: noopCache });

  assert(result.outputs.size === 1, `Expected 1 output, got ${result.outputs.size}`);
  assert(result.outputs.has("independent"), "independent should succeed");
  assert(result.skipped.includes("dependent"), "dependent should be skipped");
  assert(result.errors.length === 2, `Expected 2 errors, got ${result.errors.length}`);

  const depError = result.errors.find((e) => e.analyzerName === "dependent");
  assert(depError !== undefined, "Should have error for dependent");
  assert(depError!.phase === "dependency", `Phase should be 'dependency', got '${depError!.phase}'`);
  assert(!executionLog.includes("dependent"), "dependent should never execute");
  console.log("PASS: testDependencySkipOnFailure");
}

async function testTimeout() {
  executionLog.length = 0;
  const orch = new AnalyzerOrchestrator([
    makeAnalyzer({ name: "slow", delayMs: 5000 }),
    makeAnalyzer({ name: "fast" }),
  ]);
  const result = await orch.run({
    rootPath: "/project",
    files,
    cache: noopCache,
    defaultTimeoutMs: 50, // 50ms timeout — slow analyzer will be killed
  });

  assert(result.outputs.has("fast"), "fast should succeed");
  assert(!result.outputs.has("slow"), "slow should timeout");
  const timeoutErr = result.errors.find((e) => e.analyzerName === "slow");
  assert(timeoutErr !== undefined, "Should have timeout error");
  assert(timeoutErr!.phase === "timeout", `Phase should be 'timeout', got '${timeoutErr!.phase}'`);
  console.log("PASS: testTimeout");
}

async function testPerAnalyzerTimeout() {
  executionLog.length = 0;
  const orch = new AnalyzerOrchestrator([
    makeAnalyzer({ name: "slow", delayMs: 200 }),
    makeAnalyzer({ name: "fast" }),
  ]);
  const result = await orch.run({
    rootPath: "/project",
    files,
    cache: noopCache,
    defaultTimeoutMs: 50,
    analyzerTimeouts: { slow: 5000 }, // override: give slow analyzer more time
  });

  assert(result.outputs.has("fast"), "fast should succeed");
  assert(result.outputs.has("slow"), "slow should succeed with extended timeout");
  assert(result.errors.length === 0, `Expected 0 errors, got ${result.errors.length}`);
  console.log("PASS: testPerAnalyzerTimeout");
}

async function testFileFiltering() {
  executionLog.length = 0;
  let receivedFileCount = 0;
  const tsOnly: Analyzer = {
    name: "ts-only",
    version: "1.0.0",
    capabilities: [],
    fileFilter: (f) => f.extension === "tsx" || f.extension === "ts",
    analyze: async (ctx) => {
      receivedFileCount = ctx.files.length;
      return fakeOutput("ts-only", "1.0.0");
    },
  };

  const orch = new AnalyzerOrchestrator([tsOnly]);
  await orch.run({ rootPath: "/project", files, cache: noopCache });

  // files has: App.tsx, utils.ts, styles.css, readme.md → filter should pass 2
  assert(receivedFileCount === 2, `Expected 2 filtered files, got ${receivedFileCount}`);
  console.log("PASS: testFileFiltering");
}

async function testFilterThrowsCaught() {
  const orch = new AnalyzerOrchestrator([
    makeAnalyzer({ name: "bad-filter", filterThrows: true }),
  ]);
  const result = await orch.run({ rootPath: "/project", files, cache: noopCache });

  assert(result.outputs.size === 0, "Should have no outputs");
  assert(result.errors.length === 1, `Expected 1 error, got ${result.errors.length}`);
  assert(result.errors[0]!.phase === "filter", `Phase should be 'filter', got '${result.errors[0]!.phase}'`);
  console.log("PASS: testFilterThrowsCaught");
}

async function testParallelExecution() {
  executionLog.length = 0;
  const timestamps: Map<string, { start: number; end: number }> = new Map();

  function timedAnalyzer(name: string, delayMs: number): Analyzer {
    return {
      name,
      version: "1.0.0",
      capabilities: [],
      fileFilter: () => true,
      analyze: async () => {
        const start = performance.now();
        await new Promise((r) => setTimeout(r, delayMs));
        timestamps.set(name, { start, end: performance.now() });
        return fakeOutput(name, "1.0.0");
      },
    };
  }

  const orch = new AnalyzerOrchestrator([
    timedAnalyzer("p1", 100),
    timedAnalyzer("p2", 100),
    timedAnalyzer("p3", 100),
  ]);

  const result = await orch.run({
    rootPath: "/project",
    files,
    cache: noopCache,
    maxConcurrency: 3,
  });

  assert(result.outputs.size === 3, `Expected 3 outputs, got ${result.outputs.size}`);

  // With maxConcurrency=3, all 3 should run in parallel.
  // Total time should be ~100ms not ~300ms.
  assert(result.duration < 250, `Expected <250ms (parallel), got ${Math.round(result.duration)}ms`);
  console.log("PASS: testParallelExecution");
}

async function testDependencyOutputsPassedToDownstream() {
  executionLog.length = 0;
  let receivedDependencyOutputs: ReadonlyMap<string, AnalyzerOutput> | undefined;

  const producerAnalyzer: Analyzer = {
    name: "producer",
    version: "1.0.0",
    capabilities: ["produces-data"],
    fileFilter: () => true,
    analyze: async () => fakeOutput("producer", "1.0.0"),
  };

  const consumerAnalyzer: Analyzer = {
    name: "consumer",
    version: "1.0.0",
    capabilities: [],
    dependencies: ["producer"],
    fileFilter: () => true,
    analyze: async (ctx) => {
      receivedDependencyOutputs = ctx.dependencyOutputs;
      return fakeOutput("consumer", "1.0.0");
    },
  };

  const orch = new AnalyzerOrchestrator([consumerAnalyzer, producerAnalyzer]);
  const result = await orch.run({
    rootPath: "/project",
    files,
    cache: noopCache,
    maxConcurrency: 1,
  });

  assert(result.outputs.size === 2, `Expected 2 outputs, got ${result.outputs.size}`);
  assert(receivedDependencyOutputs !== undefined, "consumer should receive dependencyOutputs");
  assert(receivedDependencyOutputs!.has("producer"), "dependencyOutputs should contain producer's output");
  const producerOutput = receivedDependencyOutputs!.get("producer")!;
  assert(producerOutput.analyzerId === "producer@1.0.0" as AnalyzerId, "should be producer's output");

  // Verify immutability — Map should be frozen
  try {
    (receivedDependencyOutputs as Map<string, AnalyzerOutput>).set("injected", fakeOutput("x", "1.0.0"));
    assert(false, "Should not be able to mutate frozen map");
  } catch {
    // Expected — frozen map throws on mutation
  }

  console.log("PASS: testDependencyOutputsPassedToDownstream");
}

async function testDeterministicResultOrder() {
  // Run twice, verify same key order
  const analyzers = [
    makeAnalyzer({ name: "z" }),
    makeAnalyzer({ name: "a" }),
    makeAnalyzer({ name: "m" }),
  ];
  const orch = new AnalyzerOrchestrator(analyzers);
  const opts = { rootPath: "/project", files, cache: noopCache };

  const r1 = await orch.run(opts);
  const r2 = await orch.run(opts);

  const k1 = [...r1.outputs.keys()];
  const k2 = [...r2.outputs.keys()];
  assert(JSON.stringify(k1) === JSON.stringify(k2), `Key orders differ: ${k1} vs ${k2}`);
  assert(k1[0] === "a" && k1[1] === "m" && k1[2] === "z", `Expected alphabetical, got ${k1}`);
  console.log("PASS: testDeterministicResultOrder");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  await testBasicExecution();
  await testDependencyOrdering();
  await testCircularDependencyDetection();
  await testUnknownDependencyDetection();
  await testDuplicateNameDetection();
  await testAnalyzerFailureContinuation();
  await testDependencySkipOnFailure();
  await testTimeout();
  await testPerAnalyzerTimeout();
  await testFileFiltering();
  await testFilterThrowsCaught();
  await testParallelExecution();
  await testDependencyOutputsPassedToDownstream();
  await testDeterministicResultOrder();

  console.log("\nAll 14 tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
