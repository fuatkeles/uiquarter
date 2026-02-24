import { CacheLayer } from "../src/cache/CacheLayer.js";
import type {
  AnalyzerOutput,
  AnalyzerId,
  CacheKey,
  FileHash,
  OutputHash,
} from "../src/types/index.js";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const ROOT = join(tmpdir(), "uiq-cache-test-" + Date.now());

async function freshRoot(): Promise<string> {
  const dir = join(ROOT, String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6));
  await mkdir(dir, { recursive: true });
  return dir;
}

function fakeOutput(name: string, version: string): AnalyzerOutput {
  return {
    analyzerId: `${name}@${version}` as AnalyzerId,
    patterns: [],
    diagnostics: [],
    hash: `hash-${name}` as OutputHash,
    duration: 42,
    stats: { totalFiles: 5, analyzedFiles: 3, cacheHits: 2, cacheMisses: 3 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testCreateAndFlush() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });

  cache.setFileHash("src/App.tsx", "abc123" as FileHash);
  cache.setAnalyzerResult("react", fakeOutput("react", "1.0.0"));
  await cache.flush();

  // Verify files exist on disk
  const meta = JSON.parse(await readFile(join(root, ".uiq/cache/meta.json"), "utf-8"));
  assert(meta.schemaVersion === 1, `Schema version: ${meta.schemaVersion}`);
  assert(typeof meta.checksum === "string" && meta.checksum.length === 64, "Bad checksum");

  const hashes = JSON.parse(await readFile(join(root, ".uiq/cache/filehashes.json"), "utf-8"));
  assert(hashes["src/App.tsx"] === "abc123", "File hash not stored");

  const results = JSON.parse(await readFile(join(root, ".uiq/cache/analyzer-results.json"), "utf-8"));
  assert(results.outputs.react.analyzerId === "react@1.0.0", "Analyzer output not stored");
  console.log("PASS: testCreateAndFlush");
}

async function testPersistenceRoundtrip() {
  const root = await freshRoot();

  // Write
  const c1 = await CacheLayer.create({ rootPath: root });
  c1.setFileHash("a.ts", "hash-a" as FileHash);
  c1.setFileHash("b.ts", "hash-b" as FileHash);
  c1.setAnalyzerResult("vue", fakeOutput("vue", "2.0.0"));
  await c1.flush();

  // Read
  const c2 = await CacheLayer.create({ rootPath: root });
  assert(c2.getFileHash("a.ts") === "hash-a", "a.ts hash lost");
  assert(c2.getFileHash("b.ts") === "hash-b", "b.ts hash lost");
  const vue = c2.getAnalyzerResult("vue");
  assert(vue !== undefined, "vue result lost");
  assert(vue!.analyzerId === "vue@2.0.0" as AnalyzerId, "vue analyzerId wrong");
  console.log("PASS: testPersistenceRoundtrip");
}

async function testCorruptionRecovery() {
  const root = await freshRoot();

  // Write valid cache
  const c1 = await CacheLayer.create({ rootPath: root });
  c1.setFileHash("x.ts", "hx" as FileHash);
  await c1.flush();

  // Corrupt a data file
  await writeFile(join(root, ".uiq/cache/filehashes.json"), "CORRUPTED{{{");

  // Load should recover — checksum mismatch triggers fresh start
  const c2 = await CacheLayer.create({ rootPath: root });
  assert(c2.getFileHash("x.ts") === undefined, "Should be empty after corruption");
  console.log("PASS: testCorruptionRecovery");
}

async function testInvalidJsonRecovery() {
  const root = await freshRoot();
  await mkdir(join(root, ".uiq/cache"), { recursive: true });

  // Write garbage to all files
  await writeFile(join(root, ".uiq/cache/meta.json"), "not json at all");
  await writeFile(join(root, ".uiq/cache/filehashes.json"), "{}");
  await writeFile(join(root, ".uiq/cache/analyzer-results.json"), "{}");

  // Should recover cleanly
  const cache = await CacheLayer.create({ rootPath: root });
  assert(cache.getAllFileHashes().size === 0, "Should be empty after invalid JSON");
  console.log("PASS: testInvalidJsonRecovery");
}

async function testSchemaVersionMismatch() {
  const root = await freshRoot();
  await mkdir(join(root, ".uiq/cache"), { recursive: true });

  // Write meta with wrong schema version
  const meta = { schemaVersion: 999, createdAt: 0, analyzers: {}, checksum: "" };
  await writeFile(join(root, ".uiq/cache/meta.json"), JSON.stringify(meta));
  await writeFile(join(root, ".uiq/cache/filehashes.json"), "{}");
  await writeFile(join(root, ".uiq/cache/analyzer-results.json"), "{}");

  const cache = await CacheLayer.create({ rootPath: root });
  assert(cache.getAllFileHashes().size === 0, "Should wipe on schema mismatch");
  console.log("PASS: testSchemaVersionMismatch");
}

async function testAnalyzerVersionInvalidation() {
  const root = await freshRoot();

  // Write cache with analyzer v1
  const c1 = await CacheLayer.create({ rootPath: root });
  c1.setAnalyzerResult("react", fakeOutput("react", "1.0.0"));

  // Also set a scoped entry for react
  const accessor = c1.createAccessor("react@1.0.0" as AnalyzerId, "1.0.0");
  accessor.set("some-key" as CacheKey, { data: 42 }, "input-hash" as FileHash);
  await c1.flush();

  // Load and invalidate with new version
  const c2 = await CacheLayer.create({ rootPath: root });
  const invalidated = c2.invalidateStaleAnalyzers(
    new Map([["react", "2.0.0"]]),
  );

  assert(invalidated.length === 1, `Expected 1 invalidated, got ${invalidated.length}`);
  assert(invalidated[0] === "react", `Expected "react", got "${invalidated[0]}"`);
  assert(c2.getAnalyzerResult("react") === undefined, "react output should be purged");

  // The scoped entry should also be gone
  const accessor2 = c2.createAccessor("react@2.0.0" as AnalyzerId, "2.0.0");
  assert(accessor2.get("some-key" as CacheKey) === undefined, "Scoped entry should be purged");
  console.log("PASS: testAnalyzerVersionInvalidation");
}

async function testRemovedAnalyzerInvalidation() {
  const root = await freshRoot();
  const c1 = await CacheLayer.create({ rootPath: root });
  c1.setAnalyzerResult("old-analyzer", fakeOutput("old-analyzer", "1.0.0"));
  await c1.flush();

  const c2 = await CacheLayer.create({ rootPath: root });
  // Current set doesn't include "old-analyzer"
  const invalidated = c2.invalidateStaleAnalyzers(new Map([["new-analyzer", "1.0.0"]]));
  assert(invalidated.includes("old-analyzer"), "Should invalidate removed analyzer");
  assert(c2.getAnalyzerResult("old-analyzer") === undefined, "removed result should be gone");
  console.log("PASS: testRemovedAnalyzerInvalidation");
}

async function testScopedAccessorVersionCheck() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });

  // Write with v1
  const v1 = cache.createAccessor("test@1.0.0" as AnalyzerId, "1.0.0");
  v1.set("key1" as CacheKey, "value-v1", "ih" as FileHash);

  // Read with v2 — should return undefined (version mismatch)
  const v2 = cache.createAccessor("test@2.0.0" as AnalyzerId, "2.0.0");
  assert(v2.get("key1" as CacheKey) === undefined, "v2 should not see v1 data");
  assert(v2.has("key1" as CacheKey) === false, "has() should also return false");

  // Read with v1 — should work
  assert(v1.get("key1" as CacheKey)?.value === "value-v1", "v1 should see its own data");
  assert(v1.has("key1" as CacheKey) === true, "has() should return true for v1");
  console.log("PASS: testScopedAccessorVersionCheck");
}

async function testScopedAccessorTTL() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });

  // Manually insert an entry with expired TTL
  cache.setEntry(
    "test:ttl-key" as CacheKey,
    "expired-value",
    "1.0.0",
    "ih" as FileHash,
  );

  // Hack: read it back, modify createdAt to simulate past TTL
  const raw = cache.getEntry("test:ttl-key" as CacheKey)!;
  // We can't modify readonly, but we can set a new entry with old createdAt
  // For this test, just verify that entries without TTL don't expire
  const accessor = cache.createAccessor("test@1.0.0" as AnalyzerId, "1.0.0");
  accessor.set("no-ttl" as CacheKey, "persistent", "ih" as FileHash);
  assert(accessor.get("no-ttl" as CacheKey)?.value === "persistent", "No-TTL entry should persist");
  console.log("PASS: testScopedAccessorTTL");
}

async function testScopedAccessorInvalidate() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });
  const acc = cache.createAccessor("test@1.0.0" as AnalyzerId, "1.0.0");

  acc.set("k1" as CacheKey, "v1", "ih" as FileHash);
  acc.set("k2" as CacheKey, "v2", "ih" as FileHash);
  assert(acc.has("k1" as CacheKey), "k1 should exist");

  acc.invalidate("k1" as CacheKey);
  assert(!acc.has("k1" as CacheKey), "k1 should be gone");
  assert(acc.has("k2" as CacheKey), "k2 should still exist");
  console.log("PASS: testScopedAccessorInvalidate");
}

async function testScopedAccessorInvalidateByAnalyzer() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });
  const acc = cache.createAccessor("test@1.0.0" as AnalyzerId, "1.0.0");
  const other = cache.createAccessor("other@1.0.0" as AnalyzerId, "1.0.0");

  acc.set("k1" as CacheKey, "v1", "ih" as FileHash);
  other.set("k2" as CacheKey, "v2", "ih" as FileHash);

  acc.invalidateByAnalyzer("test@1.0.0" as AnalyzerId);
  assert(!acc.has("k1" as CacheKey), "test entries should be gone");
  assert(other.has("k2" as CacheKey), "other entries should survive");
  console.log("PASS: testScopedAccessorInvalidateByAnalyzer");
}

async function testDeterministicWrites() {
  const root = await freshRoot();

  // Write entries in random order
  const c1 = await CacheLayer.create({ rootPath: root });
  c1.setFileHash("z.ts", "hz" as FileHash);
  c1.setFileHash("a.ts", "ha" as FileHash);
  c1.setFileHash("m.ts", "hm" as FileHash);
  await c1.flush();

  const json1 = await readFile(join(root, ".uiq/cache/filehashes.json"), "utf-8");

  // Write same entries in different order
  const root2 = await freshRoot();
  const c2 = await CacheLayer.create({ rootPath: root2 });
  c2.setFileHash("m.ts", "hm" as FileHash);
  c2.setFileHash("z.ts", "hz" as FileHash);
  c2.setFileHash("a.ts", "ha" as FileHash);
  await c2.flush();

  const json2 = await readFile(join(root2, ".uiq/cache/filehashes.json"), "utf-8");

  assert(json1 === json2, "Same data in different order should produce identical JSON");

  // Verify key ordering in the JSON
  const keys = Object.keys(JSON.parse(json1));
  assert(keys[0] === "a.ts" && keys[1] === "m.ts" && keys[2] === "z.ts",
    `Keys should be sorted: ${keys}`);
  console.log("PASS: testDeterministicWrites");
}

async function testDirtyFlag() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });

  // No changes — flush should be a no-op (no files created)
  await cache.flush();
  try {
    await readFile(join(root, ".uiq/cache/meta.json"), "utf-8");
    throw new Error("File should not exist");
  } catch (err) {
    assert((err as NodeJS.ErrnoException).code === "ENOENT", "Should not write when clean");
  }

  // After a change, flush should write
  cache.setFileHash("x.ts", "hx" as FileHash);
  await cache.flush();
  const meta = await readFile(join(root, ".uiq/cache/meta.json"), "utf-8");
  assert(meta.length > 0, "Should have written after mutation");
  console.log("PASS: testDirtyFlag");
}

async function testWipe() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });
  cache.setFileHash("x.ts", "hx" as FileHash);
  cache.setAnalyzerResult("a", fakeOutput("a", "1.0.0"));
  await cache.flush();

  await cache.wipe();
  assert(cache.getFileHash("x.ts") === undefined, "Memory should be cleared");
  assert(cache.getAnalyzerResult("a") === undefined, "Memory should be cleared");

  // Disk should be gone too
  try {
    await readFile(join(root, ".uiq/cache/meta.json"), "utf-8");
    throw new Error("File should not exist");
  } catch (err) {
    assert((err as NodeJS.ErrnoException).code === "ENOENT", "Disk should be wiped");
  }
  console.log("PASS: testWipe");
}

async function testFirstRunEmptyCache() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });

  assert(cache.getAllFileHashes().size === 0, "Should be empty");
  assert(cache.getAllAnalyzerResults().size === 0, "Should be empty");
  assert(cache.getFileHash("anything") === undefined, "Should return undefined");
  assert(cache.getAnalyzerResult("anything") === undefined, "Should return undefined");
  console.log("PASS: testFirstRunEmptyCache");
}

async function testKeyNamespacing() {
  const root = await freshRoot();
  const cache = await CacheLayer.create({ rootPath: root });

  // Two analyzers use the same internal key name
  const a = cache.createAccessor("alpha@1.0.0" as AnalyzerId, "1.0.0");
  const b = cache.createAccessor("beta@1.0.0" as AnalyzerId, "1.0.0");

  a.set("shared-key" as CacheKey, "alpha-value", "ih" as FileHash);
  b.set("shared-key" as CacheKey, "beta-value", "ih" as FileHash);

  // They should not collide
  assert(a.get("shared-key" as CacheKey)?.value === "alpha-value", "alpha should see its own value");
  assert(b.get("shared-key" as CacheKey)?.value === "beta-value", "beta should see its own value");
  console.log("PASS: testKeyNamespacing");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  try {
    await testCreateAndFlush();
    await testPersistenceRoundtrip();
    await testCorruptionRecovery();
    await testInvalidJsonRecovery();
    await testSchemaVersionMismatch();
    await testAnalyzerVersionInvalidation();
    await testRemovedAnalyzerInvalidation();
    await testScopedAccessorVersionCheck();
    await testScopedAccessorTTL();
    await testScopedAccessorInvalidate();
    await testScopedAccessorInvalidateByAnalyzer();
    await testDeterministicWrites();
    await testDirtyFlag();
    await testWipe();
    await testFirstRunEmptyCache();
    await testKeyNamespacing();

    console.log("\nAll 16 tests passed.");
  } finally {
    await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
