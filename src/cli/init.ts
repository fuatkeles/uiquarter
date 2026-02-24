import { join, resolve } from "node:path";
import { cpus } from "node:os";
import type { Command } from "commander";
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
import { UxAnalyzer } from "../analyzers/UxAnalyzer.js";
import { AngularAnalyzer } from "../analyzers/AngularAnalyzer.js";
import { ApiRouteAnalyzer } from "../analyzers/ApiRouteAnalyzer.js";
import { DatabaseAnalyzer } from "../analyzers/DatabaseAnalyzer.js";
import { AuthAnalyzer } from "../analyzers/AuthAnalyzer.js";
import { EnvConfigAnalyzer } from "../analyzers/EnvConfigAnalyzer.js";
import { SolidAnalyzer } from "../analyzers/SolidAnalyzer.js";
import { LitAnalyzer } from "../analyzers/LitAnalyzer.js";
import { QwikAnalyzer } from "../analyzers/QwikAnalyzer.js";
import { CoverageAnalyzer } from "../analyzers/CoverageAnalyzer.js";
import { PerformanceAnalyzer } from "../analyzers/PerformanceAnalyzer.js";
import type { AnalyzerId, AnalyzerOutput } from "../types/index.js";
import { checkSchemaVersion, migrateSchema } from "../core/schemaMigration.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface InitOptions {
  dir: string;
  debug: boolean;
  cache: boolean;
  timeout?: string;
  concurrency?: string;
}

// -----------------------------------------------------------------------------
// Public: register the `init` command on a Commander program
// -----------------------------------------------------------------------------

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize UIQuarter — discover files, run analyzers, build index")
    .option("-d, --dir <path>", "root directory to scan", ".")
    .option("--debug", "enable verbose debug output", false)
    .option("--no-cache", "disable the cache layer")
    .option("--timeout <ms>", "per-analyzer timeout in milliseconds (default: 30000)")
    .option("--concurrency <n>", "max parallel analyzers (default: CPU count)")
    .action(async (opts: InitOptions) => {
      try {
        await runInit(opts);
      } catch (err) {
        logError(err, opts.debug);
        process.exitCode = 1;
      }
    });
}

// -----------------------------------------------------------------------------
// Pipeline
// -----------------------------------------------------------------------------

async function runInit(opts: InitOptions): Promise<void> {
  const rootPath = resolve(opts.dir);
  const debug = opts.debug;

  log("Initializing UIQuarter...");
  if (debug) log(`  root: ${rootPath}`);

  const pipelineStart = Date.now();

  // ── 0. Schema migration check ────────────────────────────────────────────
  const schemaCheck = await checkSchemaVersion(rootPath);
  if (schemaCheck.status === "newer-than-tool") {
    throw new Error(schemaCheck.message);
  }
  if (schemaCheck.status === "needs-migration") {
    log(`Schema migration needed (v${schemaCheck.diskVersion} → v${schemaCheck.currentVersion})`);
    const applied = await migrateSchema(rootPath);
    log(`Applied ${applied} migration(s)`);
  }
  if (debug && schemaCheck.status !== "missing") {
    log(`  schema: ${schemaCheck.status} (v${schemaCheck.diskVersion ?? "none"})`);
  }

  // ── 1. File Discovery ────────────────────────────────────────────────────
  const discoveryStart = Date.now();
  const discovery = new FileDiscovery({ rootPath });
  const files = await discovery.discover();
  const discoveryMs = Date.now() - discoveryStart;

  log(`Discovered ${files.length} files (${discoveryMs}ms)`);

  if (debug && files.length > 0) {
    const extCounts = countByKey(files, (f) => f.extension || "(none)");
    log(`  extensions: ${formatCounts(extCounts)}`);
  }

  // ── 2. Cache Layer ───────────────────────────────────────────────────────
  let cache: CacheLayer | undefined;

  if (opts.cache !== false) {
    try {
      cache = await CacheLayer.create({ rootPath });
      for (const file of files) {
        cache.setFileHash(file.relativePath, file.hash);
      }
      if (debug) log("  cache: loaded");
    } catch (err) {
      logWarn("Cache initialization failed, continuing without cache");
      if (debug) logError(err, true);
      cache = undefined;
    }
  } else if (debug) {
    log("  cache: disabled");
  }

  // ── 3. Analyzers ─────────────────────────────────────────────────────────
  const analyzers = [
    new StructureAnalyzer(),
    new ImportAnalyzer(),
    new ComponentAnalyzer(),
    new StylingAnalyzer(),
    new FileStructureAnalyzer(),
    new DependencyAnalyzer(),
    new NextjsAnalyzer(),
    new NuxtAnalyzer(),
    new SvelteKitAnalyzer(),
    new UxAnalyzer(),
    new AngularAnalyzer(),
    new ApiRouteAnalyzer(),
    new DatabaseAnalyzer(),
    new AuthAnalyzer(),
    new EnvConfigAnalyzer(),
    new SolidAnalyzer(),
    new LitAnalyzer(),
    new QwikAnalyzer(),
    new CoverageAnalyzer(),
    new PerformanceAnalyzer(),
  ];
  const orchestrator = new AnalyzerOrchestrator(analyzers);

  // Invalidate stale analyzer caches before running
  if (cache) {
    const versionMap = new Map(analyzers.map((a) => [a.name, a.version]));
    const invalidated = cache.invalidateStaleAnalyzers(versionMap);
    if (invalidated.length > 0) {
      log(`Cache invalidated for: ${invalidated.join(", ")}`);
    }
  }

  // Create a cache accessor for the orchestrator
  // If cache is disabled, use a no-op accessor
  const accessor = cache
    ? cache.createAccessor("init@0.1.0" as AnalyzerId, "0.1.0")
    : createNoopAccessor();

  const timeoutMs = opts.timeout !== undefined ? Number(opts.timeout) : undefined;
  const concurrency = opts.concurrency !== undefined
    ? Number(opts.concurrency)
    : Math.max(2, cpus().length);

  if (debug) {
    log(`  concurrency: ${concurrency}`);
    if (timeoutMs !== undefined) log(`  timeout: ${timeoutMs}ms`);
  }

  const orchStart = Date.now();
  const result = await orchestrator.run({
    rootPath,
    files,
    cache: accessor,
    maxConcurrency: concurrency,
    defaultTimeoutMs: timeoutMs,
  });
  const orchMs = Date.now() - orchStart;

  log(`Analyzed with ${analyzers.length} analyzers (${orchMs}ms)`);

  // Report errors
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      logWarn(`  [${err.phase}] ${err.analyzerName}: ${err.error.message}`);
      if (debug) log(`    ${err.error.stack ?? ""}`);
    }
  }

  // Report skipped
  if (result.skipped.length > 0) {
    logWarn(`  skipped: ${result.skipped.join(", ")}`);
  }

  if (debug) {
    for (const [name, output] of result.outputs) {
      log(`  ${name}: ${output.patterns.length} patterns, ${output.diagnostics.length} diagnostics`);
    }
  }

  // ── 4. Normalize outputs ─────────────────────────────────────────────────
  const normalizeStart = Date.now();
  const normalized = new Map<string, AnalyzerOutput>();
  for (const [name, output] of result.outputs) {
    normalized.set(name, normalizeOutput(output));
  }
  const normalizeMs = Date.now() - normalizeStart;

  if (debug) log(`Normalized outputs (${normalizeMs}ms)`);

  // ── 5. Cache results + flush ─────────────────────────────────────────────
  if (cache) {
    for (const [name, output] of normalized) {
      cache.setAnalyzerResult(name, output);
    }
    try {
      await cache.flush();
      if (debug) log("  cache: flushed to disk");
    } catch (err) {
      logWarn("Cache flush failed");
      if (debug) logError(err, true);
    }
  }

  // ── 6. Build + write index ───────────────────────────────────────────────
  const indexStart = Date.now();
  const indexer = new IntelligenceIndexer({ rootPath });
  const index = await indexer.buildAndWrite(normalized, {
    analyzerTimings: result.timings,
  });
  const indexMs = Date.now() - indexStart;

  log(
    `Built intelligence index: ${index.stats.totalPatterns} patterns, ` +
    `${index.stats.totalEdges} edges, ` +
    `${index.stats.totalFiles} files (${indexMs}ms)`,
  );

  if (debug) {
    log(`  build #${index.buildNumber}`);
    log(`  compositeHash: ${(index.compositeHash as string).slice(0, 12)}...`);
    if (Object.keys(index.stats.byFramework).length > 0) {
      log(`  byFramework: ${formatCounts(index.stats.byFramework)}`);
    }
    if (Object.keys(index.stats.byType).length > 0) {
      log(`  byType: ${formatCounts(index.stats.byType)}`);
    }
  }

  // ── 7. Generate + write insights ────────────────────────────────────────
  const insightStart = Date.now();
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
  const insightMs = Date.now() - insightStart;

  if (debug) {
    log(`Generated ${insightResult.insights.length} insights (${insightMs}ms)`);
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  const totalMs = Date.now() - pipelineStart;
  log(`Done. Output written to .uiq/ (${totalMs}ms)`);
}

// -----------------------------------------------------------------------------
// No-op CacheAccessor (used when --no-cache)
// -----------------------------------------------------------------------------

import type { CacheAccessor } from "../types/index.js";

function createNoopAccessor(): CacheAccessor {
  return {
    get: () => undefined,
    set: () => {},
    has: () => false,
    invalidate: () => {},
    invalidateByAnalyzer: () => {},
  };
}

// -----------------------------------------------------------------------------
// Logging helpers
// -----------------------------------------------------------------------------

function log(msg: string): void {
  console.log(msg);
}

function logWarn(msg: string): void {
  console.warn(`WARN: ${msg}`);
}

function logError(err: unknown, showStack: boolean): void {
  if (err instanceof Error) {
    console.error(`ERROR: ${err.message}`);
    if (showStack && err.stack) {
      console.error(err.stack);
    }
  } else {
    console.error(`ERROR: ${String(err)}`);
  }
}

function countByKey<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}(${v})`)
    .join(", ");
}
