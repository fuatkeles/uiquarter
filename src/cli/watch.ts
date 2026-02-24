import { join, relative, extname, resolve as resolvePath } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import type { FSWatcher } from "chokidar";
import { FileDiscovery } from "../core/FileDiscovery.js";
import { AnalyzerOrchestrator } from "../core/AnalyzerOrchestrator.js";
import { normalizeOutput } from "../core/normalizer.js";
import { stableStringify, atomicWrite } from "../core/utils.js";
import { InsightEngine } from "../core/InsightEngine.js";
import { CacheLayer } from "../cache/CacheLayer.js";
import { IntelligenceIndexer } from "../indexer/IntelligenceIndexer.js";
import { StructureAnalyzer } from "../analyzers/stubs.js";
import { ImportAnalyzer } from "../analyzers/ImportAnalyzer.js";
import { ComponentAnalyzer } from "../analyzers/ComponentAnalyzer.js";
import { StylingAnalyzer } from "../analyzers/StylingAnalyzer.js";
import { FileStructureAnalyzer } from "../analyzers/FileStructureAnalyzer.js";
import { DependencyAnalyzer } from "../analyzers/DependencyAnalyzer.js";
import { NextjsAnalyzer } from "../analyzers/NextjsAnalyzer.js";
import { NuxtAnalyzer } from "../analyzers/NuxtAnalyzer.js";
import { SvelteKitAnalyzer } from "../analyzers/SvelteKitAnalyzer.js";
import type {
  Analyzer,
  AnalyzerId,
  AnalyzerOutput,
  DiscoveredFile,
} from "../types/index.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 300;

const WATCH_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "vue", "svelte",
  "css", "scss", "sass", "less",
  "mjs", "cjs",
]);

const WATCH_GLOB = ".";

const IGNORED_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/.uiq/**",
];

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface WatchCommandOptions {
  readonly dir?: string;
  readonly debounceMs?: number;
  readonly verbose?: boolean;
}

export type WatchEventKind = "add" | "change" | "unlink";

export interface WatchEvent {
  readonly kind: WatchEventKind;
  readonly relativePath: string;
  readonly absolutePath: string;
}

/** Exposed for testing: the internal state of the watch controller. */
export interface WatchController {
  readonly watcher: FSWatcher;
  readonly stop: () => Promise<void>;
  readonly rootPath: string;
}

// -----------------------------------------------------------------------------
// Logger
// -----------------------------------------------------------------------------

export interface WatchLogger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const consoleLogger: WatchLogger = {
  log: (msg) => console.log(msg),
  warn: (msg) => console.warn(`WARN: ${msg}`),
  error: (msg) => console.error(`ERROR: ${msg}`),
};

// -----------------------------------------------------------------------------
// Analyzer helpers
// -----------------------------------------------------------------------------

function createAllAnalyzers(): Analyzer[] {
  return [
    new StructureAnalyzer(),
    new ImportAnalyzer(),
    new ComponentAnalyzer(),
    new StylingAnalyzer(),
    new FileStructureAnalyzer(),
    new DependencyAnalyzer(),
    new NextjsAnalyzer(),
    new NuxtAnalyzer(),
    new SvelteKitAnalyzer(),
  ];
}

// -----------------------------------------------------------------------------
// Incremental pipeline
// -----------------------------------------------------------------------------

/**
 * Determine which analyzers need to run for a set of changed files.
 *
 * An analyzer needs to re-run if:
 *  1. Any changed file passes its fileFilter, OR
 *  2. It depends (transitively) on an analyzer that needs to re-run
 */
export function determineAffectedAnalyzers(
  analyzers: readonly Analyzer[],
  changedFiles: readonly DiscoveredFile[],
): readonly string[] {
  const needsRun = new Set<string>();

  // Direct matches: analyzers whose fileFilter accepts a changed file
  for (const analyzer of analyzers) {
    for (const file of changedFiles) {
      if (analyzer.fileFilter(file)) {
        needsRun.add(analyzer.name);
        break;
      }
    }
  }

  // Transitive: if a dep needs to re-run, the dependent does too
  let changed = true;
  while (changed) {
    changed = false;
    for (const analyzer of analyzers) {
      if (needsRun.has(analyzer.name)) continue;
      for (const dep of analyzer.dependencies ?? []) {
        if (needsRun.has(dep)) {
          needsRun.add(analyzer.name);
          changed = true;
          break;
        }
      }
    }
  }

  return [...needsRun].sort();
}

async function runIncrementalPipeline(
  rootPath: string,
  events: readonly WatchEvent[],
  cache: CacheLayer,
  allAnalyzers: Analyzer[],
  verbose: boolean,
  logger: WatchLogger,
): Promise<void> {
  const pipelineStart = Date.now();

  // 1. Invalidate cache for changed/removed files
  const invalidatedAnalyzers = new Set<string>();
  for (const event of events) {
    const names = cache.invalidateFile(event.relativePath);
    for (const n of names) invalidatedAnalyzers.add(n);
  }

  // 2. Rebuild full file list (incremental discovery isn't worth the complexity)
  const discovery = new FileDiscovery({ rootPath });
  const files = await discovery.discover();

  // 3. Update file hashes in cache
  for (const file of files) {
    cache.setFileHash(file.relativePath, file.hash);
  }

  // 4. Determine which changed files to feed into analyzer filter
  const changedPaths = new Set(events.map((e) => e.relativePath));
  const changedFiles = files.filter((f) => changedPaths.has(f.relativePath));

  // For removed files, create stub entries for analyzer filter testing
  for (const event of events) {
    if (event.kind === "unlink") {
      changedPaths.delete(event.relativePath);
    }
  }

  // 5. Determine which analyzers need to re-run
  const affected = determineAffectedAnalyzers(allAnalyzers, changedFiles);

  // If files were removed, all file-structure sensitive analyzers should re-run
  const hasRemovals = events.some((e) => e.kind === "unlink");
  const analyzersToRun = hasRemovals
    ? allAnalyzers.map((a) => a.name).sort()
    : affected.length > 0
      ? affected
      : allAnalyzers.map((a) => a.name).sort();

  if (verbose) {
    logger.log(`  Analyzers to re-run: ${analyzersToRun.join(", ")}`);
  }

  // 6. Run the analyzer orchestrator with ALL analyzers (deps needed)
  //    but results will be merged with cached results
  const orchestrator = new AnalyzerOrchestrator(allAnalyzers);
  const accessor = cache.createAccessor("watch@0.1.0" as AnalyzerId, "0.1.0");

  const result = await orchestrator.run({
    rootPath,
    files,
    cache: accessor,
  });

  // Report errors
  for (const err of result.errors) {
    logger.warn(`  [${err.phase}] ${err.analyzerName}: ${err.error.message}`);
  }
  if (result.skipped.length > 0) {
    logger.warn(`  skipped: ${result.skipped.join(", ")}`);
  }

  // 7. Normalize
  const normalized = new Map<string, AnalyzerOutput>();
  for (const [name, output] of result.outputs) {
    normalized.set(name, normalizeOutput(output));
  }

  // 8. Cache results
  for (const [name, output] of normalized) {
    cache.setAnalyzerResult(name, output);
  }
  await cache.flush();

  // 9. Build index
  const indexer = new IntelligenceIndexer({ rootPath });
  const index = await indexer.buildAndWrite(normalized);

  // 10. Generate insights
  const insightEngine = new InsightEngine();
  const insightResult = insightEngine.generate(index);
  const insightsPayload = stableStringify({
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    hash: insightResult.hash,
    stats: insightResult.stats,
    insights: insightResult.insights,
  });
  await atomicWrite(join(rootPath, ".uiq", "insights.json"), insightsPayload);

  const totalMs = Date.now() - pipelineStart;

  logger.log(
    `  Rebuilt: ${index.stats.totalPatterns} patterns, ` +
    `${index.stats.totalEdges} edges (${totalMs}ms)`,
  );
}

// -----------------------------------------------------------------------------
// Watch controller
// -----------------------------------------------------------------------------

/**
 * Start a file watcher on the project root.
 *
 * @param options.dir - Project root directory (defaults to cwd)
 * @param options.debounceMs - Debounce delay in ms (default: 300)
 * @param options.verbose - Show detailed logs
 * @param logger - Optional logger (defaults to console)
 * @returns A WatchController that can be used to stop the watcher
 */
export async function startWatch(
  options?: WatchCommandOptions,
  logger?: WatchLogger,
): Promise<WatchController> {
  const log = logger ?? consoleLogger;
  const rootPath = resolvePath(options?.dir ?? process.cwd());
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const verbose = options?.verbose === true;

  log.log(`Watching ${rootPath} for changes (debounce: ${debounceMs}ms)`);

  // Load cache
  const cache = await CacheLayer.create({ rootPath });

  // Create analyzers once
  const allAnalyzers = createAllAnalyzers();

  // Pending events accumulator + debounce timer
  let pendingEvents: WatchEvent[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;

  const processBatch = async (): Promise<void> => {
    if (pendingEvents.length === 0 || processing) return;

    processing = true;
    const batch = [...pendingEvents];
    pendingEvents = [];

    // Deduplicate: keep latest event per file path
    const byPath = new Map<string, WatchEvent>();
    for (const event of batch) {
      byPath.set(event.relativePath, event);
    }
    const deduped = [...byPath.values()].sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );

    // Log events
    for (const event of deduped) {
      switch (event.kind) {
        case "add":
          log.log(`[+] File added: ${event.relativePath}`);
          break;
        case "change":
          log.log(`[~] File changed: ${event.relativePath}`);
          break;
        case "unlink":
          log.log(`[-] File removed: ${event.relativePath}`);
          break;
      }
    }

    try {
      await runIncrementalPipeline(
        rootPath,
        deduped,
        cache,
        allAnalyzers,
        verbose,
        log,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Pipeline failed: ${msg}`);
      if (err instanceof Error && err.stack && verbose) {
        log.error(err.stack);
      }
    } finally {
      processing = false;

      // If events accumulated during processing, schedule another batch
      if (pendingEvents.length > 0) {
        scheduleBatch();
      }
    }
  };

  const scheduleBatch = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void processBatch();
    }, debounceMs);
  };

  const handleEvent = (kind: WatchEventKind, filePath: string): void => {
    const relativePath = relative(rootPath, filePath).replace(/\\/g, "/");

    // Validate extension
    const ext = extname(filePath);
    const extNoDot = ext.startsWith(".") ? ext.slice(1) : ext;
    if (!WATCH_EXTENSIONS.has(extNoDot)) return;

    pendingEvents.push({
      kind,
      relativePath,
      absolutePath: filePath,
    });

    scheduleBatch();
  };

  // Start chokidar watcher
  // Note: awaitWriteFinish is intentionally omitted — it can suppress events
  // on certain platforms (notably Windows temp dirs). The debounce mechanism
  // already coalesces rapid successive writes effectively.
  const watcher = chokidarWatch(WATCH_GLOB, {
    cwd: rootPath,
    ignored: IGNORED_DIRS,
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("add", (path) => handleEvent("add", join(rootPath, path)));
  watcher.on("change", (path) => handleEvent("change", join(rootPath, path)));
  watcher.on("unlink", (path) => handleEvent("unlink", join(rootPath, path)));

  watcher.on("error", (error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Watcher error: ${msg}`);
    log.error("Stopping watcher due to critical error.");
    void stop();
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    await watcher.close();
    log.log("Watcher stopped.");
  };

  // Wait for watcher to be ready (once, not on)
  await new Promise<void>((resolve) => {
    const onReady = (): void => {
      log.log("Watcher ready. Waiting for changes...");
      resolve();
    };
    watcher.once("ready", onReady);
  });

  return { watcher, stop, rootPath };
}

// -----------------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------------

/**
 * Run the `uiquarter watch` command.
 *
 * Starts the watcher and keeps the process alive until interrupted.
 */
export async function runWatchCommand(
  options?: WatchCommandOptions,
): Promise<void> {
  const controller = await startWatch(options);

  // Keep alive until SIGINT/SIGTERM
  const exitHandler = (): void => {
    console.log("\nReceived stop signal.");
    void controller.stop().then(() => process.exit(0));
  };

  process.on("SIGINT", exitHandler);
  process.on("SIGTERM", exitHandler);

  // Keep event loop alive
  await new Promise<void>(() => {
    // Never resolves — watcher keeps process alive via chokidar
  });
}
