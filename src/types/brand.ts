/**
 * Branded type utility.
 *
 * Prevents accidental interchange of structurally identical primitives.
 * A FileHash cannot be passed where a CacheKey is expected, even though
 * both are strings at runtime. Zero runtime cost — erased by the compiler.
 */
declare const __brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** SHA-256 hex digest of file contents — drives cache invalidation */
export type FileHash = Brand<string, "FileHash">;

/** Composite key: `${analyzer.name}@${analyzer.version}` */
export type AnalyzerId = Brand<string, "AnalyzerId">;

/** Stable identifier for a discovered pattern: `${filePath}:${name}:${line}` */
export type PatternId = Brand<string, "PatternId">;

/** Deterministic cache key derived from inputs, not wall-clock time */
export type CacheKey = Brand<string, "CacheKey">;

/** SHA-256 hex digest of serialized output — proves determinism */
export type OutputHash = Brand<string, "OutputHash">;
