import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerOutput,
  CacheAccessor,
  DiscoveredFile,
} from "../types/index.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface OrchestratorOptions {
  /** Absolute path to the project root */
  rootPath: string;

  /** All discovered files (pre-hashed). Analyzers receive a filtered subset. */
  files: readonly DiscoveredFile[];

  /** Shared cache accessor. Passed through to each analyzer's context. */
  cache: CacheAccessor;

  /**
   * Previous results from the last orchestrator run, keyed by analyzer name.
   * Each inner map is keyed by file path. Enables incremental analysis.
   */
  previousResults?: ReadonlyMap<string, ReadonlyMap<string, AnalyzerOutput>>;

  /** Max analyzers running concurrently within a single execution level. Default: 4. */
  maxConcurrency?: number;

  /** Default per-analyzer timeout in ms. Default: 30 000 (30s). */
  defaultTimeoutMs?: number;

  /** Per-analyzer timeout overrides, keyed by analyzer name. */
  analyzerTimeouts?: Readonly<Record<string, number>>;
}

export interface OrchestratorResult {
  /** Analyzer outputs keyed by name. Insertion order follows execution levels, then alphabetical. */
  readonly outputs: ReadonlyMap<string, AnalyzerOutput>;

  /** Every error encountered during the run (filter, analyze, timeout, or dependency skip). */
  readonly errors: readonly OrchestratorError[];

  /** Analyzer names that were skipped because a dependency failed. */
  readonly skipped: readonly string[];

  /** Total wall-clock duration of the orchestration run in ms. */
  readonly duration: number;

  /** Per-analyzer wall-clock timing in ms. */
  readonly timings: Readonly<Record<string, number>>;
}

export type OrchestratorErrorPhase =
  | "filter"
  | "analyze"
  | "timeout"
  | "dependency";

export interface OrchestratorError {
  readonly analyzerName: string;
  readonly error: Error;
  readonly phase: OrchestratorErrorPhase;
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

/**
 * AnalyzerOrchestrator — runs a set of Analyzer instances with:
 *
 *   1. Topological ordering via declared `dependencies`
 *   2. Level-based parallelism (independent analyzers run concurrently)
 *   3. Bounded concurrency within each level
 *   4. Per-analyzer hard timeout (AbortSignal + Promise.race)
 *   5. Fault isolation (one failure does not crash the pipeline)
 *
 * Determinism:
 *   - Execution levels are computed via Kahn's algorithm.
 *   - Within each level, analyzers are sorted alphabetically.
 *   - The result map preserves this order (JS Map insertion order).
 *   - Same analyzers + same files → same result map key order.
 *
 * Failure policy:
 *   - If an analyzer throws or times out, the error is captured.
 *   - Downstream analyzers that declared a dependency on it are skipped.
 *   - All other analyzers continue normally.
 */
export class AnalyzerOrchestrator {
  private readonly analyzerMap: ReadonlyMap<string, Analyzer>;

  constructor(analyzers: readonly Analyzer[]) {
    const map = new Map<string, Analyzer>();
    for (const a of analyzers) {
      if (map.has(a.name)) {
        throw new Error(`Duplicate analyzer name: "${a.name}"`);
      }
      map.set(a.name, a);
    }
    this.analyzerMap = map;
  }

  async run(options: OrchestratorOptions): Promise<OrchestratorResult> {
    const start = performance.now();
    const maxConcurrency = options.maxConcurrency ?? 4;
    const defaultTimeout = options.defaultTimeoutMs ?? 30_000;

    // Phase 1 — resolve dependency graph into execution levels
    const levels = this.resolveExecutionLevels();

    // Mutable accumulators — filled during Phase 2
    const outputs = new Map<string, AnalyzerOutput>();
    const errors: OrchestratorError[] = [];
    const skipped: string[] = [];
    const failed = new Set<string>();
    const timings = new Map<string, number>();

    // Phase 2 — execute level by level
    for (const level of levels) {
      // Partition into runnable vs skipped
      const runnable: string[] = [];

      for (const name of level) {
        const analyzer = this.analyzerMap.get(name)!;
        const deps = analyzer.dependencies ?? [];
        const failedDep = deps.find((d) => failed.has(d));

        if (failedDep !== undefined) {
          skipped.push(name);
          failed.add(name); // propagate: anything depending on this is also skipped
          errors.push({
            analyzerName: name,
            error: new Error(
              `Skipped: dependency "${failedDep}" failed or was skipped`,
            ),
            phase: "dependency",
          });
          continue;
        }

        runnable.push(name);
      }

      // Run this level with bounded concurrency
      await this.runLevel(
        runnable,
        options,
        maxConcurrency,
        defaultTimeout,
        outputs,
        errors,
        failed,
        timings,
      );
    }

    // Phase 3 — build deterministic result map (level order → alphabetical)
    const orderedOutputs = new Map<string, AnalyzerOutput>();
    for (const level of levels) {
      for (const name of level) {
        const output = outputs.get(name);
        if (output) {
          orderedOutputs.set(name, output);
        }
      }
    }

    // Build sorted timings record
    const sortedTimings: Record<string, number> = {};
    for (const name of [...timings.keys()].sort()) {
      sortedTimings[name] = Math.round(timings.get(name)!);
    }

    return {
      outputs: orderedOutputs,
      errors,
      skipped,
      duration: performance.now() - start,
      timings: sortedTimings,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — topological sort (Kahn's algorithm with levels)
  // ---------------------------------------------------------------------------

  /**
   * Returns an array of "levels". Each level is a sorted array of analyzer
   * names whose dependencies are all in earlier levels. Analyzers within
   * the same level are independent and can run in parallel.
   *
   * Throws on:
   *   - Unknown dependency (analyzer declares dep on a name not registered)
   *   - Circular dependency (graph has a cycle)
   */
  private resolveExecutionLevels(): string[][] {
    const names = [...this.analyzerMap.keys()];
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const name of names) {
      inDegree.set(name, 0);
      dependents.set(name, []);
    }

    for (const [name, analyzer] of this.analyzerMap) {
      for (const dep of analyzer.dependencies ?? []) {
        if (!this.analyzerMap.has(dep)) {
          throw new Error(
            `Analyzer "${name}" depends on unknown analyzer "${dep}"`,
          );
        }
        inDegree.set(name, inDegree.get(name)! + 1);
        dependents.get(dep)!.push(name);
      }
    }

    const levels: string[][] = [];
    let queue = names.filter((n) => inDegree.get(n) === 0);
    let processed = 0;

    while (queue.length > 0) {
      // Sort alphabetically within each level for determinism
      queue.sort();
      levels.push([...queue]);
      processed += queue.length;

      const next: string[] = [];
      for (const name of queue) {
        for (const dependent of dependents.get(name)!) {
          const deg = inDegree.get(dependent)! - 1;
          inDegree.set(dependent, deg);
          if (deg === 0) {
            next.push(dependent);
          }
        }
      }
      queue = next;
    }

    if (processed !== names.length) {
      const stuck = names
        .filter((n) => inDegree.get(n)! > 0)
        .sort();
      throw new Error(
        `Circular dependency detected among analyzers: ${stuck.join(", ")}`,
      );
    }

    return levels;
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — bounded-concurrency execution within a single level
  // ---------------------------------------------------------------------------

  private async runLevel(
    names: readonly string[],
    options: OrchestratorOptions,
    maxConcurrency: number,
    defaultTimeout: number,
    outputs: Map<string, AnalyzerOutput>,
    errors: OrchestratorError[],
    failed: Set<string>,
    timings: Map<string, number>,
  ): Promise<void> {
    if (names.length === 0) return;

    // Snapshot of completed outputs — frozen so analyzers cannot mutate it.
    // Taken once per level (all dependencies are in earlier levels).
    const snapshot = new Map(outputs);
    Object.freeze(snapshot);

    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < names.length) {
        const idx = cursor++;
        const name = names[idx]!;
        const analyzer = this.analyzerMap.get(name)!;
        const timeout =
          options.analyzerTimeouts?.[name] ?? defaultTimeout;

        const analyzerStart = performance.now();
        try {
          const output = await this.executeAnalyzer(
            analyzer,
            options,
            timeout,
            snapshot,
          );
          outputs.set(name, output);
        } catch (err) {
          failed.add(name);
          errors.push({
            analyzerName: name,
            error: err instanceof Error ? err : new Error(String(err)),
            phase: detectPhase(err),
          });
        }
        timings.set(name, performance.now() - analyzerStart);
      }
    };

    const workerCount = Math.min(maxConcurrency, names.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );
  }

  // ---------------------------------------------------------------------------
  // Single analyzer execution with file filtering + timeout
  // ---------------------------------------------------------------------------

  private async executeAnalyzer(
    analyzer: Analyzer,
    options: OrchestratorOptions,
    timeoutMs: number,
    completedOutputs: ReadonlyMap<string, AnalyzerOutput>,
  ): Promise<AnalyzerOutput> {
    // 1. Apply file filter — wrapped so a buggy filter is caught with phase info
    let filtered: DiscoveredFile[];
    try {
      filtered = options.files.filter((f) => analyzer.fileFilter(f));
    } catch (cause) {
      throw new PhaseError(
        "filter",
        `fileFilter threw for "${analyzer.name}": ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 2. Setup cooperative + hard timeout
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutRace = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new PhaseError(
            "timeout",
            `Analyzer "${analyzer.name}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });

    // 3. Build context
    const previousForAnalyzer =
      options.previousResults?.get(analyzer.name) ?? new Map<string, AnalyzerOutput>();

    const context: AnalyzerContext = {
      rootPath: options.rootPath,
      files: filtered,
      cache: options.cache,
      previousResults: previousForAnalyzer,
      dependencyOutputs: completedOutputs,
      signal: controller.signal,
      schemaVersion: "2.0",
    };

    // 4. Race: analyze vs hard timeout
    try {
      const output = await Promise.race([
        analyzer.analyze(context),
        timeoutRace,
      ]);

      // Augment with execution metrics (non-deterministic, excluded from hash)
      return {
        ...output,
        metadata: {
          ...output.metadata,
          execution: {
            timeMs: output.duration,
            patternCount: output.patterns.length,
            diagnosticCount: output.diagnostics.length,
          },
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Tagged error for phase detection. Not exported — the orchestrator
 * unwraps it into OrchestratorError.phase before returning.
 */
class PhaseError extends Error {
  constructor(
    readonly phase: OrchestratorErrorPhase,
    message: string,
  ) {
    super(message);
    this.name = "PhaseError";
  }
}

function detectPhase(err: unknown): OrchestratorErrorPhase {
  if (err instanceof PhaseError) return err.phase;
  return "analyze";
}
