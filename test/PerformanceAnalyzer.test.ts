import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PerformanceAnalyzer } from "../src/analyzers/PerformanceAnalyzer.js";
import type { DiscoveredFile, CacheAccessor, FileHash } from "../src/types/index.js";

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
  const tmp = await mkdtemp(join(tmpdir(), "uiq-perf-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(tmp, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
  return tmp;
}

function fakeFile(relativePath: string, ext: string): DiscoveredFile {
  return {
    relativePath,
    absolutePath: `/fake/${relativePath}`,
    extension: ext,
    hash: "abc123" as FileHash,
    size: 100,
    lastModified: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testInterface(): Promise<void> {
  const analyzer = new PerformanceAnalyzer();
  assert.equal(analyzer.name, "performance");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("react-profiler-detection"));
  assert.ok(analyzer.capabilities.includes("lighthouse-detection"));
  assert.ok(analyzer.capabilities.includes("custom-profiler-detection"));
  ok("testInterface");
}

async function testFileFilter(): Promise<void> {
  const analyzer = new PerformanceAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("profiler.json", "json")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/utils.ts", "ts")), false);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testFileFilter");
}

async function testParseReactProfiler(): Promise<void> {
  const profilerData = JSON.stringify({
    dataForRoots: [
      {
        commitData: [
          {
            fiberSelfDurations: { "1": 3.5, "2": 7.2 },
            fiberNames: { "1": "App", "2": "Header" },
          },
        ],
      },
    ],
  });
  const tmp = await createProject({
    "profiler.json": profilerData,
  });
  try {
    const analyzer = new PerformanceAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("profiler.json", "json")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect profiler patterns");
    const appPerf = output.patterns.find(p => p.name === "perf:App");
    assert.ok(appPerf, "should detect App component perf data");
    const headerPerf = output.patterns.find(p => p.name === "perf:Header");
    assert.ok(headerPerf, "should detect Header component perf data");
    ok("testParseReactProfiler");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testParseLighthouse(): Promise<void> {
  const lighthouseData = JSON.stringify({
    lighthouseVersion: "10.0",
    categories: {
      performance: { score: 0.85 },
    },
    audits: {
      "largest-contentful-paint": { numericValue: 1500 },
      "first-contentful-paint": { numericValue: 800 },
      "total-blocking-time": { numericValue: 200 },
    },
  });
  const tmp = await createProject({
    "lighthouse.json": lighthouseData,
  });
  try {
    const analyzer = new PerformanceAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("lighthouse.json", "json")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect lighthouse patterns");
    const lhPattern = output.patterns.find(p => p.name === "lighthouse-scores");
    assert.ok(lhPattern, "should detect lighthouse scores");
    assert.equal(lhPattern!.metadata.performanceScore, 0.85);
    assert.equal(lhPattern!.metadata.lcp, 1500);
    ok("testParseLighthouse");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testNoProfilerData(): Promise<void> {
  const tmp = await createProject({
    "data.json": JSON.stringify({ someField: "value" }),
  });
  try {
    const analyzer = new PerformanceAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("data.json", "json")],
      cache: createNoopCache(),
    });
    const summary = output.patterns.find(p => p.name === "performance-summary");
    assert.ok(summary, "should have performance summary");
    assert.equal(summary!.metadata.hasProfilerData, false);
    assert.equal(summary!.metadata.hasLighthouseData, false);
    ok("testNoProfilerData");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testCustomPerfFormat(): Promise<void> {
  const customData = JSON.stringify({
    components: [
      { name: "Button", avgRenderMs: 5, renderCount: 100 },
      { name: "Modal", avgRenderMs: 12, renderCount: 50 },
    ],
  });
  const tmp = await createProject({
    "perf-data.json": customData,
  });
  try {
    const analyzer = new PerformanceAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("perf-data.json", "json")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect custom profiler data");
    const buttonPerf = output.patterns.find(p => p.name === "perf:Button");
    assert.ok(buttonPerf, "should detect Button perf data");
    assert.equal(buttonPerf!.metadata.avgRenderMs, 5);
    assert.equal(buttonPerf!.metadata.renderCount, 100);
    const modalPerf = output.patterns.find(p => p.name === "perf:Modal");
    assert.ok(modalPerf, "should detect Modal perf data");
    ok("testCustomPerfFormat");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testDeterministic(): Promise<void> {
  const customData = JSON.stringify({
    components: [
      { name: "Button", avgRenderMs: 5, renderCount: 100 },
    ],
  });
  const tmp = await createProject({
    "perf-data.json": customData,
  });
  try {
    const analyzer = new PerformanceAnalyzer();
    const files = [fakeFile("perf-data.json", "json")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("PerformanceAnalyzer Tests");
  await testInterface();
  await testFileFilter();
  await testParseReactProfiler();
  await testParseLighthouse();
  await testNoProfilerData();
  await testCustomPerfFormat();
  await testDeterministic();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
