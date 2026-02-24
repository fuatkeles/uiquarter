import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { compare, stableStringify } from "../core/utils.js";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerId,
  AnalyzerOutput,
  CacheKey,
  DiscoveredFile,
  FileHash,
  PatternId,
  PatternResult,
  PatternType,
  OutputHash,
} from "../types/index.js";

// -----------------------------------------------------------------------------
// Constants & Regex
// -----------------------------------------------------------------------------

const QWIK_EXTENSIONS = new Set(["tsx", "ts", "jsx"]);

/** Framework detection */
const QWIK_IMPORT_RE = /from\s+['"]@builder\.io\/qwik['"]/;
const QWIK_CITY_IMPORT_RE = /from\s+['"]@builder\.io\/qwik-city['"]/;

/** component$() definitions */
const COMPONENT_DOLLAR_RE = /(?:export\s+(?:default\s+)?)?(?:const\s+(\w+)\s*=\s*)?component\$\s*\(/g;

/** Reactive primitives */
const USE_SIGNAL_RE = /\buseSignal\s*[<(]/g;
const USE_STORE_RE = /\buseStore\s*[<(]/g;
const USE_COMPUTED_RE = /\buseComputed\$\s*\(/g;

/** Task hooks */
const USE_TASK_RE = /\buseTask\$\s*\(/g;
const USE_VISIBLE_TASK_RE = /\buseVisibleTask\$\s*\(/g;

/** Server functions */
const ROUTE_LOADER_RE = /\brouteLoader\$\s*\(/g;
const ROUTE_ACTION_RE = /\brouteAction\$\s*\(/g;
const SERVER_DOLLAR_RE = /\bserver\$\s*\(/g;

/** Lazy closures */
const DOLLAR_RE = /\$\s*\(\s*(?:async\s*)?\(/g;

/** File-based routes */
const ROUTES_DIR_RE = /(?:^|\/)routes\//;
const LAYOUT_FILE_RE = /layout\.tsx$/;
const INDEX_FILE_RE = /index\.tsx$/;

/** useResource$ */
const USE_RESOURCE_RE = /\buseResource\$\s*\(/g;

/** useContext / createContextId */
const USE_CONTEXT_RE = /\buseContext\s*\(/g;
const CREATE_CONTEXT_RE = /\bcreateContextId\s*[<(]/g;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface QwikFileMetrics {
  readonly filePath: string;
  readonly isQwik: boolean;
  readonly componentNames: readonly string[];
  readonly signalCount: number;
  readonly storeCount: number;
  readonly computedCount: number;
  readonly taskCount: number;
  readonly visibleTaskCount: number;
  readonly routeLoaderCount: number;
  readonly routeActionCount: number;
  readonly serverFnCount: number;
  readonly dollarCount: number;
  readonly resourceCount: number;
  readonly contextCount: number;
  readonly isRouteLayout: boolean;
  readonly isRouteIndex: boolean;
  readonly isInRoutesDir: boolean;
}

// -----------------------------------------------------------------------------
// QwikAnalyzer
// -----------------------------------------------------------------------------

export class QwikAnalyzer implements Analyzer {
  readonly name = "qwik";
  readonly version = "1.0.0";
  readonly capabilities = [
    "component-detection",
    "signal-detection",
    "store-detection",
    "task-detection",
    "route-loader-detection",
    "route-action-detection",
    "server-function-detection",
    "file-route-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return QWIK_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: QwikFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `qwik:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<QwikFileMetrics>(cacheKey);
      if (cached !== undefined) {
        allMetrics.push(cached.value);
        cacheHits++;
        continue;
      }

      let content: string;
      try {
        content = await readFile(
          posix.join(context.rootPath, file.relativePath.replace(/\\/g, "/")),
          "utf-8",
        );
      } catch {
        try {
          const { join } = await import("node:path");
          content = await readFile(join(context.rootPath, file.relativePath), "utf-8");
        } catch {
          continue;
        }
      }

      const metrics = analyzeQwikFile(file, content);
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Only produce output if Qwik detected
    const qwikFiles = allMetrics.filter((m) => m.isQwik);
    if (qwikFiles.length === 0) {
      const duration = Date.now() - start;
      const hash = computeOutputHash([], []);
      return {
        analyzerId: `${this.name}@${this.version}` as AnalyzerId,
        patterns: [],
        diagnostics: [],
        hash,
        duration,
        stats: {
          totalFiles: context.files.length,
          analyzedFiles: allMetrics.length,
          cacheHits,
          cacheMisses: allMetrics.length - cacheHits,
        },
      };
    }

    // Aggregate
    let totalComponents = 0;
    let totalSignals = 0;
    let totalStores = 0;
    let totalTasks = 0;
    let totalRouteLoaders = 0;
    let totalRouteActions = 0;
    let totalServerFns = 0;
    let totalRouteFiles = 0;

    for (const m of qwikFiles) {
      totalComponents += m.componentNames.length;
      totalSignals += m.signalCount;
      totalStores += m.storeCount;
      totalTasks += m.taskCount + m.visibleTaskCount;
      totalRouteLoaders += m.routeLoaderCount;
      totalRouteActions += m.routeActionCount;
      totalServerFns += m.serverFnCount;
      if (m.isInRoutesDir) totalRouteFiles++;

      // Component patterns
      for (const name of m.componentNames) {
        const pid = `${m.filePath}:component:${name}` as PatternId;
        patterns.push({
          id: pid,
          type: "component" as PatternType,
          name,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.95,
            source: "qwik-detection",
            factors: [{ name: "component-dollar", weight: 1, score: 0.95 }],
          },
          framework: "qwik",
          dependencies: [],
          properties: {},
          metadata: {
            resumable: true,
            signalCount: m.signalCount,
            storeCount: m.storeCount,
            taskCount: m.taskCount,
            visibleTaskCount: m.visibleTaskCount,
          },
        });
      }

      // Route layout patterns
      if (m.isRouteLayout) {
        const pid = `${m.filePath}:layout:1` as PatternId;
        patterns.push({
          id: pid,
          type: "layout" as PatternType,
          name: `layout:${extractRoutePath(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "file-route-detection",
            factors: [{ name: "qwik-layout-file", weight: 1, score: 0.9 }],
          },
          framework: "qwik",
          dependencies: [],
          properties: {},
          metadata: { isRouteLayout: true },
        });
      }

      // Route index patterns
      if (m.isRouteIndex) {
        const pid = `${m.filePath}:page:1` as PatternId;
        patterns.push({
          id: pid,
          type: "page" as PatternType,
          name: `page:${extractRoutePath(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "file-route-detection",
            factors: [{ name: "qwik-index-file", weight: 1, score: 0.9 }],
          },
          framework: "qwik",
          dependencies: [],
          properties: {},
          metadata: { isRouteIndex: true },
        });
      }

      // Server function patterns
      if (m.serverFnCount > 0 || m.routeLoaderCount > 0 || m.routeActionCount > 0) {
        const pid = `${m.filePath}:server:1` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `server:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "qwik-detection",
            factors: [{ name: "server-function", weight: 1, score: 0.9 }],
          },
          framework: "qwik",
          dependencies: [],
          properties: {},
          metadata: {
            routeLoaderCount: m.routeLoaderCount,
            routeActionCount: m.routeActionCount,
            serverFnCount: m.serverFnCount,
          },
        });
      }
    }

    // Summary pattern
    const summaryId = `.:qwik-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "qwik-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.95,
        source: "qwik-analysis",
        factors: [{ name: "framework-detection", weight: 1, score: 0.95 }],
      },
      framework: "qwik",
      dependencies: [],
      properties: {},
      metadata: {
        totalResumableComponents: totalComponents,
        totalSignals,
        totalStores,
        totalTasks,
        totalRouteLoaders,
        totalRouteActions,
        totalServerFunctions: totalServerFns,
        totalRouteFiles,
        qwikFileCount: qwikFiles.length,
      },
    });

    // Sort for determinism
    patterns.sort((a, b) => compare(a.id as string, b.id as string));
    diagnostics.sort((a, b) => compare(a.message, b.message));

    const duration = Date.now() - start;
    const hash = computeOutputHash(patterns, diagnostics);

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash,
      duration,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: allMetrics.length,
        cacheHits,
        cacheMisses: allMetrics.length - cacheHits,
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Per-file analysis
// -----------------------------------------------------------------------------

function analyzeQwikFile(file: DiscoveredFile, content: string): QwikFileMetrics {
  const isQwik = QWIK_IMPORT_RE.test(content) || QWIK_CITY_IMPORT_RE.test(content);

  if (!isQwik) {
    return {
      filePath: file.relativePath,
      isQwik: false,
      componentNames: [],
      signalCount: 0,
      storeCount: 0,
      computedCount: 0,
      taskCount: 0,
      visibleTaskCount: 0,
      routeLoaderCount: 0,
      routeActionCount: 0,
      serverFnCount: 0,
      dollarCount: 0,
      resourceCount: 0,
      contextCount: 0,
      isRouteLayout: false,
      isRouteIndex: false,
      isInRoutesDir: false,
    };
  }

  const normPath = file.relativePath.replace(/\\/g, "/");
  const isInRoutesDir = ROUTES_DIR_RE.test(normPath);
  const isRouteLayout = isInRoutesDir && LAYOUT_FILE_RE.test(normPath);
  const isRouteIndex = isInRoutesDir && INDEX_FILE_RE.test(normPath);

  // Component names
  const componentNames: string[] = [];
  const compRe = new RegExp(COMPONENT_DOLLAR_RE.source, COMPONENT_DOLLAR_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = compRe.exec(content)) !== null) {
    const name = match[1] ?? extractFileName(file.relativePath);
    componentNames.push(name);
  }

  return {
    filePath: file.relativePath,
    isQwik: true,
    componentNames,
    signalCount: countMatches(content, USE_SIGNAL_RE),
    storeCount: countMatches(content, USE_STORE_RE),
    computedCount: countMatches(content, USE_COMPUTED_RE),
    taskCount: countMatches(content, USE_TASK_RE),
    visibleTaskCount: countMatches(content, USE_VISIBLE_TASK_RE),
    routeLoaderCount: countMatches(content, ROUTE_LOADER_RE),
    routeActionCount: countMatches(content, ROUTE_ACTION_RE),
    serverFnCount: countMatches(content, SERVER_DOLLAR_RE),
    dollarCount: countMatches(content, DOLLAR_RE),
    resourceCount: countMatches(content, USE_RESOURCE_RE),
    contextCount: countMatches(content, USE_CONTEXT_RE) + countMatches(content, CREATE_CONTEXT_RE),
    isRouteLayout,
    isRouteIndex,
    isInRoutesDir,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function countMatches(content: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags);
  let count = 0;
  while (re.exec(content) !== null) count++;
  return count;
}

function extractFileName(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const fileName = parts[parts.length - 1] ?? "";
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
}

function extractRoutePath(relativePath: string): string {
  const normPath = relativePath.replace(/\\/g, "/");
  const routesIdx = normPath.indexOf("routes/");
  if (routesIdx === -1) return "/";
  const afterRoutes = normPath.slice(routesIdx + "routes/".length);
  const dir = afterRoutes.split("/").slice(0, -1).join("/");
  return "/" + dir;
}

function computeOutputHash(
  patterns: readonly PatternResult[],
  diagnostics: readonly AnalyzerDiagnostic[],
): OutputHash {
  const payload = stableStringify({ patterns, diagnostics });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
