import type { AnalyzerId, OutputHash } from "./brand.js";
import type { DiscoveredFile } from "./file.js";
import type { CacheAccessor } from "./cache.js";
import type { PatternResult } from "./pattern.js";

/** Severity levels for diagnostics emitted during analysis */
export type DiagnosticSeverity = "error" | "warning" | "info";

/** A structured diagnostic — not an exception, but a reportable finding */
export interface AnalyzerDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly filePath: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * Everything an analyzer needs to do its job.
 *
 * Key design choices:
 *   - `files` is the pre-filtered set (fileFilter already applied by the runner)
 *   - `cache` is scoped to this analyzer's namespace automatically
 *   - `previousResults` enables incremental diffing without global state
 *   - `dependencyOutputs` provides outputs from completed dependency analyzers
 *   - `signal` allows cooperative cancellation (watch mode, timeouts)
 */
export interface AnalyzerContext {
  /** Absolute path to project root */
  readonly rootPath: string;

  /** Files that passed this analyzer's fileFilter — already hashed */
  readonly files: readonly DiscoveredFile[];

  /** Scoped cache accessor — keys are namespaced to this analyzer */
  readonly cache: CacheAccessor;

  /** Results from the previous run of *this* analyzer, keyed by file path */
  readonly previousResults: ReadonlyMap<string, AnalyzerOutput>;

  /**
   * Immutable snapshot of outputs from dependency analyzers that have
   * already completed in the current run. Keyed by analyzer name.
   *
   * Only includes outputs from analyzers listed in this analyzer's
   * `dependencies` array (plus their transitive dependencies).
   * Empty for analyzers with no dependencies.
   *
   * This map is frozen — analyzers MUST NOT attempt to modify it.
   */
  readonly dependencyOutputs: ReadonlyMap<string, AnalyzerOutput>;

  /** Cooperative cancellation (ctrl-c in watch mode, timeout in CI) */
  readonly signal?: AbortSignal;

  /** Schema version for the current analysis run (set by orchestrator) */
  readonly schemaVersion?: string;
}

/**
 * Deterministic output from a single analyzer run.
 *
 * Determinism contract:
 *   Same (analyzer version + input file hashes) → identical outputHash.
 *   The runner verifies this in debug mode by running twice and comparing.
 *
 * The `hash` field is computed over the serialized patterns + diagnostics,
 * excluding timing fields. This lets the cache and incremental rebuild
 * system detect true no-ops without deep comparison.
 */
export interface AnalyzerOutput {
  readonly analyzerId: AnalyzerId;
  readonly patterns: readonly PatternResult[];
  readonly diagnostics: readonly AnalyzerDiagnostic[];

  /** Deterministic hash of patterns + diagnostics (excludes timing) */
  readonly hash: OutputHash;

  /** Wall-clock duration in ms — informational only, excluded from hash */
  readonly duration: number;

  /** How many files were actually analyzed (vs. cache hits) */
  readonly stats: AnalyzerStats;

  /** Non-deterministic metadata — excluded from hash computation */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AnalyzerStats {
  readonly totalFiles: number;
  readonly analyzedFiles: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

/**
 * The analyzer contract.
 *
 * Every analyzer is a stateless plugin. No constructor side effects,
 * no singletons, no ambient state. The runner owns the lifecycle:
 *
 *   1. Runner calls `fileFilter` to build the file set
 *   2. Runner constructs an `AnalyzerContext` with scoped cache
 *   3. Runner calls `analyze(context)` and collects output
 *   4. Runner verifies `output.hash` for determinism (debug mode)
 *
 * Analyzers that need heavy setup (WASM parsers, model loading) do it
 * lazily on first `analyze` call, not at import time.
 */
export interface Analyzer {
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly string[];

  /**
   * Names of analyzers that must complete before this one runs.
   * Used by the orchestrator for topological ordering.
   * Omit or pass empty array if this analyzer has no ordering constraints.
   */
  readonly dependencies?: readonly string[];

  /** If true, this analyzer is superseded and will be removed in a future version */
  readonly deprecated?: boolean;

  /** Return true if this analyzer should process the given file */
  fileFilter(file: DiscoveredFile): boolean;

  /** Run analysis on the provided context. Must be deterministic. */
  analyze(context: AnalyzerContext): Promise<AnalyzerOutput>;
}
