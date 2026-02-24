import type { CacheKey, FileHash, AnalyzerId } from "./brand.js";

/**
 * A single cache entry. Generic over the stored value.
 *
 * Cache versioning strategy:
 *   key      = deterministic function of (analyzer ID + input file hashes)
 *   version  = analyzer version at write time
 *   inputHash = combined hash of all inputs that produced this entry
 *
 * On read, if the current analyzer version !== entry.version, the entry
 * is stale and must be recomputed. This gives every analyzer a free
 * cache-bust on version bump with zero coordination.
 */
export interface CacheEntry<T = unknown> {
  readonly key: CacheKey;
  readonly value: T;

  /** Analyzer version that produced this entry */
  readonly version: string;

  /** Combined hash of all input files at write time */
  readonly inputHash: FileHash;

  /** Epoch ms — for TTL expiry and LRU eviction, never for correctness */
  readonly createdAt: number;

  /** Time-to-live in ms. Undefined = never expires by time. */
  readonly ttl?: number;
}

/**
 * Cache accessor passed into AnalyzerContext.
 * Analyzers never touch the backing store directly.
 */
export interface CacheAccessor {
  get<T>(key: CacheKey): CacheEntry<T> | undefined;
  set<T>(key: CacheKey, value: T, inputHash: FileHash): void;
  has(key: CacheKey): boolean;
  invalidate(key: CacheKey): void;

  /** Drop all entries written by a specific analyzer version */
  invalidateByAnalyzer(analyzerId: AnalyzerId): void;
}
