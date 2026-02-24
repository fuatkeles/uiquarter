import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CoverageAnalyzer } from "../src/analyzers/CoverageAnalyzer.js";
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
  const tmp = await mkdtemp(join(tmpdir(), "uiq-cov-"));
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
  const analyzer = new CoverageAnalyzer();
  assert.equal(analyzer.name, "coverage");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("lcov-parsing"));
  assert.ok(analyzer.capabilities.includes("istanbul-parsing"));
  assert.ok(analyzer.capabilities.includes("per-file-coverage"));
  ok("testInterface");
}

async function testFileFilter(): Promise<void> {
  const analyzer = new CoverageAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("coverage/lcov.info", "info")), true);
  assert.equal(analyzer.fileFilter(fakeFile("coverage-summary.json", "json")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/utils.ts", "ts")), false);
  assert.equal(analyzer.fileFilter(fakeFile("coverage/something.html", "html")), true);
  ok("testFileFilter");
}

async function testParseLcov(): Promise<void> {
  const lcovContent = `SF:src/Button.tsx
DA:1,1
DA:2,1
DA:3,0
LH:2
LF:3
end_of_record
`;
  const tmp = await createProject({
    "coverage/lcov.info": lcovContent,
  });
  try {
    const analyzer = new CoverageAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("coverage/lcov.info", "info")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should produce patterns");
    const fileCov = output.patterns.find(p => p.name === "coverage:Button");
    assert.ok(fileCov, "should have per-file coverage for Button");
    assert.equal(fileCov!.metadata.linesHit, 2);
    assert.equal(fileCov!.metadata.linesFound, 3);
    ok("testParseLcov");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testParseIstanbul(): Promise<void> {
  const istanbulContent = JSON.stringify({
    total: {
      lines: { total: 100, covered: 85, skipped: 0, pct: 85 },
      branches: { total: 20, covered: 14, skipped: 0, pct: 70 },
    },
    "src/App.tsx": {
      lines: { total: 50, covered: 45, skipped: 0, pct: 90 },
      branches: { total: 10, covered: 8, skipped: 0, pct: 80 },
    },
  });
  const tmp = await createProject({
    "coverage-summary.json": istanbulContent,
  });
  try {
    const analyzer = new CoverageAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("coverage-summary.json", "json")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should produce patterns");
    const summary = output.patterns.find(p => p.name === "coverage-summary");
    assert.ok(summary, "should have summary pattern");
    assert.equal(summary!.metadata.hasCoverageData, true);
    ok("testParseIstanbul");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testNoCoverageFile(): Promise<void> {
  const tmp = await createProject({
    "src/utils.ts": "export const x = 1;",
  });
  try {
    const analyzer = new CoverageAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [],
      cache: createNoopCache(),
    });
    const summary = output.patterns.find(p => p.name === "coverage-summary");
    assert.ok(summary, "should have summary even with no files");
    assert.equal(summary!.metadata.filesCovered, 0);
    assert.equal(summary!.metadata.hasCoverageData, false);
    ok("testNoCoverageFile");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testCoveragePerFile(): Promise<void> {
  const lcovContent = `SF:src/Button.tsx
DA:1,1
DA:2,1
LH:2
LF:2
end_of_record
SF:src/Modal.tsx
DA:1,1
DA:2,0
DA:3,0
LH:1
LF:3
end_of_record
`;
  const tmp = await createProject({
    "coverage/lcov.info": lcovContent,
  });
  try {
    const analyzer = new CoverageAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("coverage/lcov.info", "info")],
      cache: createNoopCache(),
    });
    const buttonCov = output.patterns.find(p => p.name === "coverage:Button");
    assert.ok(buttonCov, "should have Button coverage");
    const modalCov = output.patterns.find(p => p.name === "coverage:Modal");
    assert.ok(modalCov, "should have Modal coverage");
    assert.equal(modalCov!.metadata.linesHit, 1);
    assert.equal(modalCov!.metadata.linesFound, 3);
    ok("testCoveragePerFile");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testDeterministicOutput(): Promise<void> {
  const lcovContent = `SF:src/Button.tsx
LH:5
LF:10
end_of_record
`;
  const tmp = await createProject({
    "coverage/lcov.info": lcovContent,
  });
  try {
    const analyzer = new CoverageAnalyzer();
    const files = [fakeFile("coverage/lcov.info", "info")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testDeterministicOutput");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testEmptyLcov(): Promise<void> {
  const tmp = await createProject({
    "coverage/lcov.info": "",
  });
  try {
    const analyzer = new CoverageAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("coverage/lcov.info", "info")],
      cache: createNoopCache(),
    });
    // Empty lcov has no SF: entries, so it might be treated as unknown format
    // and filtered out, resulting in the empty-summary branch
    const summary = output.patterns.find(p => p.name === "coverage-summary");
    assert.ok(summary, "should still produce a summary");
    ok("testEmptyLcov");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("CoverageAnalyzer Tests");
  await testInterface();
  await testFileFilter();
  await testParseLcov();
  await testParseIstanbul();
  await testNoCoverageFile();
  await testCoveragePerFile();
  await testDeterministicOutput();
  await testEmptyLcov();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
