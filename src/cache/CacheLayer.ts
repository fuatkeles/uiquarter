import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AnalyzerOutput,
  CacheAccessor,
  CacheEntry,
  CacheKey,
  FileHash,
  AnalyzerId,
} from "../types/index.js";
import { atomicWrite, stableStringify } from "../core/utils.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Bump this when the on-disk format changes in a backward-incompatible way.
 * Any cache written with a different schema version is wiped on load.
 */
const SCHEMA_VERSION = 1;

const CACHE_DIR_NAME = ".uiq/cache";
const FILE_HASHES_NAME = "filehashes.json";
const ANALYZER_RESULTS_NAME = "analyzer-results.json";
const META_NAME = "meta.json";

// -----------------------------------------------------------------------------
// On-disk JSON structures (internal — never exported)
// -----------------------------------------------------------------------------

interface DiskMeta {
  schemaVersion: number;
  createdAt: number;
  /** Analyzer name → version at last successful run */
  analyzers: Record<string, string>;
  /** SHA-256(filehashes.json bytes + analyzer-results.json bytes) */
  checksum: string;
}

interface DiskResults {
  /** Full AnalyzerOutput per analyzer name (orchestrator level) */
  outputs: Record<string, AnalyzerOutput>;
  /** General-purpose CacheEntry objects (analyzer internal use, namespaced keys) */
  entries: Record<string, CacheEntry>;
}

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface CacheLayerOptions {
  /** Absolute path to the project root. Cache lives at `<rootPath>/.uiq/cache/`. */
  rootPath: string;
}

// -----------------------------------------------------------------------------
// CacheLayer
// -----------------------------------------------------------------------------

/**
 * Disk-backed cache with integrity verification and version-aware invalidation.
 *
 * On-disk layout:
 *
 *   .uiq/cache/
 *   ├── meta.json               — schema version, analyzer versions, integrity checksum
 *   ├── filehashes.json          — relativePath → FileHash map
 *   └── analyzer-results.json    — AnalyzerOutput objects + general CacheEntry objects
 *
 * Integrity model:
 *   meta.json stores a SHA-256 checksum computed over the raw bytes of the
 *   other two files. On load, the checksum is recomputed and compared.
 *   Any mismatch — partial write, manual edit, disk corruption — triggers
 *   a full wipe and clean start. No partial recovery is attempted because
 *   the cost of a cold cache is low and the risk of using corrupt data is high.
 *
 * Invalidation triggers:
 *   1. Schema version mismatch → full wipe
 *   2. Checksum mismatch       → full wipe (corruption)
 *   3. Analyzer version change  → selective purge of that analyzer's data
 *   4. TTL expiry               → entry skipped on read (lazy eviction)
 *   5. Manual invalidation      → single key or all keys for an analyzer
 *
 * Write strategy:
 *   All mutations are in-memory until `flush()` is called.
 *   `flush()` serializes with deterministic key ordering (sorted),
 *   writes each file atomically (temp + rename), and updates the
 *   integrity checksum last.
 */
export class CacheLayer {
  private fileHashes: Map<string, FileHash>;
  private analyzerOutputs: Map<string, AnalyzerOutput>;
  private entries: Map<string, CacheEntry>;
  private analyzerVersions: Map<string, string>;
  private dirty = false;

  private constructor(
    private readonly cacheDir: string,
    fileHashes: Map<string, FileHash>,
    analyzerOutputs: Map<string, AnalyzerOutput>,
    entries: Map<string, CacheEntry>,
    analyzerVersions: Map<string, string>,
  ) {
    this.fileHashes = fileHashes;
    this.analyzerOutputs = analyzerOutputs;
    this.entries = entries;
    this.analyzerVersions = analyzerVersions;
  }

  /**
   * Load cache from disk, or create a fresh instance if the cache is
   * missing, corrupt, or uses an incompatible schema version.
   */
  static async create(options: CacheLayerOptions): Promise<CacheLayer> {
    const cacheDir = join(options.rootPath, CACHE_DIR_NAME);
    await mkdir(cacheDir, { recursive: true });

    try {
      return await CacheLayer.loadFromDisk(cacheDir);
    } catch (err) {
      // Corruption, schema mismatch, or first run — start clean.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        process.stderr.write("WARN: Cache corrupted or incompatible; rebuilding from scratch.\n");
      }
      return CacheLayer.empty(cacheDir);
    }
  }

  // ---------------------------------------------------------------------------
  // File hashes
  // ---------------------------------------------------------------------------

  getFileHash(relativePath: string): FileHash | undefined {
    return this.fileHashes.get(relativePath);
  }

  setFileHash(relativePath: string, hash: FileHash): void {
    if (this.fileHashes.get(relativePath) !== hash) {
      this.fileHashes.set(relativePath, hash);
      this.dirty = true;
    }
  }

  getAllFileHashes(): ReadonlyMap<string, FileHash> {
    return this.fileHashes;
  }

  // ---------------------------------------------------------------------------
  // Analyzer outputs (orchestrator level — full AnalyzerOutput per analyzer)
  // ---------------------------------------------------------------------------

  getAnalyzerResult(analyzerName: string): AnalyzerOutput | undefined {
    return this.analyzerOutputs.get(analyzerName);
  }

  setAnalyzerResult(analyzerName: string, output: AnalyzerOutput): void {
    this.analyzerOutputs.set(analyzerName, output);
    // Track the version so invalidateStaleAnalyzers can detect changes
    const version = extractVersion(output.analyzerId);
    if (version) {
      this.analyzerVersions.set(analyzerName, version);
    }
    this.dirty = true;
  }

  getAllAnalyzerResults(): ReadonlyMap<string, AnalyzerOutput> {
    return this.analyzerOutputs;
  }

  // ---------------------------------------------------------------------------
  // General-purpose cache entries (analyzer internal use, namespaced keys)
  // ---------------------------------------------------------------------------

  getEntry<T>(key: CacheKey): CacheEntry<T> | undefined {
    return this.entries.get(key) as CacheEntry<T> | undefined;
  }

  setEntry(
    key: CacheKey,
    value: unknown,
    version: string,
    inputHash: FileHash,
  ): void {
    this.entries.set(key, {
      key,
      value,
      version,
      inputHash,
      createdAt: Date.now(),
    });
    this.dirty = true;
  }

  hasEntry(key: CacheKey): boolean {
    return this.entries.has(key);
  }

  invalidateEntry(key: CacheKey): void {
    if (this.entries.delete(key)) {
      this.dirty = true;
    }
  }

  /**
   * Remove all cache entries whose key starts with the analyzer's name prefix,
   * plus the analyzer's stored output.
   *
   * AnalyzerId format: `"name@version"`. The prefix used for namespaced
   * entry keys is `"name:"`.
   */
  invalidateByAnalyzerId(analyzerId: AnalyzerId): void {
    const name = extractAnalyzerName(analyzerId);
    this.purgeAnalyzer(name);
  }

  // ---------------------------------------------------------------------------
  // Version-based invalidation
  // ---------------------------------------------------------------------------

  /**
   * Compare stored analyzer versions against the currently registered set.
   * For every mismatch (version bumped or analyzer removed), purge all
   * cached data for that analyzer.
   *
   * Call this before running analyzers so stale data never leaks into
   * a new run.
   *
   * Returns the names of analyzers whose cache was invalidated.
   */
  invalidateStaleAnalyzers(
    currentVersions: ReadonlyMap<string, string>,
  ): string[] {
    const invalidated: string[] = [];

    // Detect version changes
    for (const [name, currentVersion] of currentVersions) {
      const stored = this.analyzerVersions.get(name);
      if (stored !== undefined && stored !== currentVersion) {
        this.purgeAnalyzer(name);
        invalidated.push(name);
      }
      this.analyzerVersions.set(name, currentVersion);
    }

    // Detect removed analyzers (in cache but not in current set)
    for (const name of [...this.analyzerVersions.keys()]) {
      if (!currentVersions.has(name)) {
        this.purgeAnalyzer(name);
        this.analyzerVersions.delete(name);
        invalidated.push(name);
      }
    }

    if (invalidated.length > 0) {
      this.dirty = true;
    }

    return invalidated;
  }

  // ---------------------------------------------------------------------------
  // Scoped CacheAccessor factory
  // ---------------------------------------------------------------------------

  /**
   * Create a CacheAccessor scoped to a specific analyzer.
   *
   * - Keys are automatically prefixed with `"analyzerName:"` to prevent
   *   collisions between analyzers.
   * - The analyzer's version is injected into every `set()` call.
   * - `get()` returns `undefined` for entries written by a different version
   *   or past their TTL — the caller never sees stale data.
   */
  createAccessor(analyzerId: AnalyzerId, version: string): CacheAccessor {
    const name = extractAnalyzerName(analyzerId);
    return new ScopedAccessor(this, analyzerId, version, name);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Write all in-memory state to disk atomically.
   *
   * Write order:
   *   1. filehashes.json   (atomic: temp → rename)
   *   2. analyzer-results.json (atomic: temp → rename)
   *   3. meta.json          (atomic: temp → rename, contains checksum of 1+2)
   *
   * If the process crashes between steps, the checksum in meta.json won't
   * match the new data files, so the next load detects corruption and
   * wipes cleanly. No partial state survives.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    await mkdir(this.cacheDir, { recursive: true });

    // 1. Serialize with deterministic key ordering
    const hashesJson = stableStringify(
      sortedObject(this.fileHashes),
    );
    const resultsJson = stableStringify({
      outputs: sortedObject(this.analyzerOutputs),
      entries: sortedObject(this.entries),
    });

    // 2. Compute integrity checksum BEFORE writing
    const checksum = computeChecksum(hashesJson, resultsJson);

    const metaJson = stableStringify({
      schemaVersion: SCHEMA_VERSION,
      createdAt: Date.now(),
      analyzers: sortedObject(this.analyzerVersions),
      checksum,
    } satisfies DiskMeta);

    // 3. Atomic writes — data files first, meta last
    await atomicWrite(join(this.cacheDir, FILE_HASHES_NAME), hashesJson);
    await atomicWrite(join(this.cacheDir, ANALYZER_RESULTS_NAME), resultsJson);
    await atomicWrite(join(this.cacheDir, META_NAME), metaJson);

    this.dirty = false;
  }

  // ---------------------------------------------------------------------------
  // Single-file invalidation (for watch / incremental mode)
  // ---------------------------------------------------------------------------

  /**
   * Invalidate all cached data related to a single file.
   *
   * This removes the file's hash and purges any cache entries whose key
   * contains the file path, plus any analyzer outputs that included patterns
   * for this file.  Used by the watch command to enable incremental re-analysis.
   *
   * @returns The names of analyzers whose cached output was invalidated.
   */
  invalidateFile(relativePath: string): string[] {
    const invalidated: string[] = [];

    // 1. Remove file hash
    if (this.fileHashes.delete(relativePath)) {
      this.dirty = true;
    }

    // 2. Invalidate cache entries whose key contains the file path
    const normalizedPath = relativePath.replace(/\\/g, "/");
    for (const key of [...this.entries.keys()]) {
      if (key.includes(normalizedPath)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }

    // 3. Invalidate analyzer outputs that reference this file
    for (const [name, output] of this.analyzerOutputs) {
      const hasFile = output.patterns.some(
        (p) => p.filePath.replace(/\\/g, "/") === normalizedPath,
      );
      if (hasFile) {
        this.analyzerOutputs.delete(name);
        invalidated.push(name);
        this.dirty = true;
      }
    }

    return invalidated.sort();
  }

  /**
   * Return the set of analyzer names that have cached output.
   * Used by watch mode to determine which analyzers need re-running.
   */
  getCachedAnalyzerNames(): readonly string[] {
    return [...this.analyzerOutputs.keys()].sort();
  }

  /** Delete everything — on-disk and in-memory. */
  async wipe(): Promise<void> {
    this.fileHashes.clear();
    this.analyzerOutputs.clear();
    this.entries.clear();
    this.analyzerVersions.clear();
    this.dirty = false;

    try {
      await rm(this.cacheDir, { recursive: true, force: true });
    } catch {
      // Already gone or permission issue — nothing we can do
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private static async loadFromDisk(cacheDir: string): Promise<CacheLayer> {
    // 1. Read meta — must exist and parse cleanly
    const metaRaw = await readFile(join(cacheDir, META_NAME), "utf-8");
    const meta = safeJsonParse<DiskMeta>(metaRaw);

    // 2. Schema version gate
    if (meta.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `Schema version mismatch: expected ${SCHEMA_VERSION}, got ${meta.schemaVersion}`,
      );
    }

    // 3. Read data files as raw strings (for checksum before parsing)
    const hashesRaw = await readFile(
      join(cacheDir, FILE_HASHES_NAME),
      "utf-8",
    );
    const resultsRaw = await readFile(
      join(cacheDir, ANALYZER_RESULTS_NAME),
      "utf-8",
    );

    // 4. Integrity check — raw bytes, not parsed objects
    const actual = computeChecksum(hashesRaw, resultsRaw);
    if (meta.checksum !== actual) {
      throw new Error("Cache integrity check failed — checksum mismatch");
    }

    // 5. Parse (safe — JSON.parse errors become thrown errors → fresh start)
    const hashes = safeJsonParse<Record<string, string>>(hashesRaw);
    const results = safeJsonParse<DiskResults>(resultsRaw);

    return new CacheLayer(
      cacheDir,
      new Map(Object.entries(hashes)) as Map<string, FileHash>,
      new Map(Object.entries(results.outputs ?? {})) as Map<
        string,
        AnalyzerOutput
      >,
      new Map(Object.entries(results.entries ?? {})) as Map<
        string,
        CacheEntry
      >,
      new Map(Object.entries(meta.analyzers ?? {})),
    );
  }

  private static empty(cacheDir: string): CacheLayer {
    return new CacheLayer(
      cacheDir,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
  }

  /** Remove an analyzer's output and all its namespaced cache entries. */
  private purgeAnalyzer(name: string): void {
    this.analyzerOutputs.delete(name);
    const prefix = name + ":";
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// ScopedAccessor — implements CacheAccessor for a single analyzer
// -----------------------------------------------------------------------------

/**
 * Wraps CacheLayer to provide a per-analyzer view of the cache.
 *
 * - Keys are namespaced: `"analyzerName:originalKey"`
 * - Version is injected on write, checked on read
 * - TTL is checked on read (lazy eviction)
 */
class ScopedAccessor implements CacheAccessor {
  constructor(
    private readonly layer: CacheLayer,
    _analyzerId: AnalyzerId, // retained in signature for documentation
    private readonly version: string,
    private readonly prefix: string,
  ) {}

  get<T>(key: CacheKey): CacheEntry<T> | undefined {
    const scoped = this.scopeKey(key);
    const entry = this.layer.getEntry<T>(scoped);
    if (!entry) return undefined;

    // Version mismatch → stale (analyzer was upgraded)
    if (entry.version !== this.version) return undefined;

    // TTL expired → lazy eviction
    if (
      entry.ttl !== undefined &&
      Date.now() > entry.createdAt + entry.ttl
    ) {
      this.layer.invalidateEntry(scoped);
      return undefined;
    }

    return entry;
  }

  set<T>(key: CacheKey, value: T, inputHash: FileHash): void {
    this.layer.setEntry(
      this.scopeKey(key),
      value,
      this.version,
      inputHash,
    );
  }

  has(key: CacheKey): boolean {
    return this.get(key) !== undefined;
  }

  invalidate(key: CacheKey): void {
    this.layer.invalidateEntry(this.scopeKey(key));
  }

  invalidateByAnalyzer(analyzerId: AnalyzerId): void {
    this.layer.invalidateByAnalyzerId(analyzerId);
  }

  private scopeKey(key: CacheKey): CacheKey {
    return `${this.prefix}:${key}` as CacheKey;
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function extractAnalyzerName(analyzerId: AnalyzerId): string {
  const atIdx = (analyzerId as string).lastIndexOf("@");
  if (atIdx <= 0) return analyzerId as string;
  return (analyzerId as string).slice(0, atIdx);
}

function extractVersion(analyzerId: AnalyzerId): string | undefined {
  const atIdx = (analyzerId as string).lastIndexOf("@");
  if (atIdx <= 0) return undefined;
  return (analyzerId as string).slice(atIdx + 1);
}

function safeJsonParse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Cache file contains invalid JSON");
  }
}

function computeChecksum(hashesRaw: string, resultsRaw: string): string {
  return createHash("sha256")
    .update(hashesRaw)
    .update(resultsRaw)
    .digest("hex");
}

/** Convert a Map to a plain object with sorted keys. */
function sortedObject<V>(map: Map<string, V>): Record<string, V> {
  const obj: Record<string, V> = {};
  for (const key of [...map.keys()].sort()) {
    obj[key] = map.get(key)!;
  }
  return obj;
}
