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

const SOLID_EXTENSIONS = new Set(["tsx", "jsx", "ts", "js"]);

/** Framework detection — imports from solid-js or @solidjs/router */
const SOLID_IMPORT_RE = /from\s+['"]solid-js(?:\/[\w/-]*)?['"]/;
const SOLIDJS_ROUTER_RE = /from\s+['"]@solidjs\/router['"]/;

/** Reactive primitives */
const CREATE_SIGNAL_RE = /\bcreateSignal\s*[<(]/g;
const CREATE_EFFECT_RE = /\bcreateEffect\s*\(/g;
const CREATE_MEMO_RE = /\bcreateMemo\s*\(/g;
const CREATE_RESOURCE_RE = /\bcreateResource\s*\(/g;

/** Store */
const CREATE_STORE_RE = /\bcreateStore\s*\(/g;
const PRODUCE_RE = /\bproduce\s*\(/g;

/** Router hooks */
const USE_PARAMS_RE = /\buseParams\s*\(/g;
const USE_NAVIGATE_RE = /\buseNavigate\s*\(/g;
const USE_LOCATION_RE = /\buseLocation\s*\(/g;

/** Control flow JSX components */
const SHOW_RE = /<Show\b/g;
const FOR_RE = /<For\b/g;
const SWITCH_RE = /<Switch\b/g;
const MATCH_RE = /<Match\b/g;
const INDEX_RE = /<Index\b/g;
const DYNAMIC_RE = /<Dynamic\b/g;

/** Error/Suspense boundaries */
const SUSPENSE_RE = /<Suspense\b/g;
const ERROR_BOUNDARY_RE = /<ErrorBoundary\b/g;

/** Lazy loading */
const LAZY_RE = /\blazy\s*\(\s*\(\)\s*=>/g;

/** Component detection (function returning JSX) */
const EXPORT_COMPONENT_RE = /export\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w*)/g;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface SolidFileMetrics {
  readonly filePath: string;
  readonly isSolid: boolean;
  readonly componentNames: readonly string[];
  readonly signalCount: number;
  readonly effectCount: number;
  readonly memoCount: number;
  readonly resourceCount: number;
  readonly storeCount: number;
  readonly produceCount: number;
  readonly useParamsCount: number;
  readonly useNavigateCount: number;
  readonly useLocationCount: number;
  readonly showCount: number;
  readonly forCount: number;
  readonly switchCount: number;
  readonly matchCount: number;
  readonly indexCount: number;
  readonly dynamicCount: number;
  readonly suspenseCount: number;
  readonly errorBoundaryCount: number;
  readonly lazyCount: number;
}

// -----------------------------------------------------------------------------
// SolidAnalyzer
// -----------------------------------------------------------------------------

export class SolidAnalyzer implements Analyzer {
  readonly name = "solid";
  readonly version = "1.0.0";
  readonly capabilities = [
    "signal-detection",
    "effect-detection",
    "memo-detection",
    "resource-detection",
    "store-detection",
    "control-flow-detection",
    "router-detection",
    "lazy-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return SOLID_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: SolidFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `solid:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<SolidFileMetrics>(cacheKey);
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

      const metrics = analyzeSolidFile(file, content);
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Only produce output if Solid detected
    const solidFiles = allMetrics.filter((m) => m.isSolid);
    if (solidFiles.length === 0) {
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
    let totalSignals = 0;
    let totalEffects = 0;
    let totalMemos = 0;
    let totalResources = 0;
    let totalStores = 0;
    let totalComponents = 0;
    let totalControlFlow = 0;
    let totalLazy = 0;

    for (const m of solidFiles) {
      totalSignals += m.signalCount;
      totalEffects += m.effectCount;
      totalMemos += m.memoCount;
      totalResources += m.resourceCount;
      totalStores += m.storeCount;
      totalComponents += m.componentNames.length;
      totalControlFlow += m.showCount + m.forCount + m.switchCount + m.matchCount + m.indexCount + m.dynamicCount;
      totalLazy += m.lazyCount;

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
            value: 0.9,
            source: "solid-detection",
            factors: [{ name: "solid-component", weight: 1, score: 0.9 }],
          },
          framework: "solid",
          dependencies: [],
          properties: {},
          metadata: {
            signalCount: m.signalCount,
            effectCount: m.effectCount,
            memoCount: m.memoCount,
            resourceCount: m.resourceCount,
            storeCount: m.storeCount,
          },
        });
      }

      // Hook-like patterns for files with reactive primitives but no components
      if (m.componentNames.length === 0 && (m.signalCount > 0 || m.effectCount > 0 || m.storeCount > 0)) {
        const hookName = extractFileName(m.filePath);
        const pid = `${m.filePath}:hook:${hookName}` as PatternId;
        patterns.push({
          id: pid,
          type: "hook" as PatternType,
          name: hookName,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.8,
            source: "solid-detection",
            factors: [{ name: "solid-reactive-hook", weight: 1, score: 0.8 }],
          },
          framework: "solid",
          dependencies: [],
          properties: {},
          metadata: {
            signalCount: m.signalCount,
            effectCount: m.effectCount,
            storeCount: m.storeCount,
          },
        });
      }
    }

    // Summary pattern
    const summaryId = `.:solid-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "solid-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.95,
        source: "solid-analysis",
        factors: [{ name: "framework-detection", weight: 1, score: 0.95 }],
      },
      framework: "solid",
      dependencies: [],
      properties: {},
      metadata: {
        totalComponents,
        totalSignals,
        totalEffects,
        totalMemos,
        totalResources,
        totalStores,
        totalControlFlow,
        totalLazy,
        solidFileCount: solidFiles.length,
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

function analyzeSolidFile(file: DiscoveredFile, content: string): SolidFileMetrics {
  const isSolid = SOLID_IMPORT_RE.test(content) || SOLIDJS_ROUTER_RE.test(content);

  if (!isSolid) {
    return {
      filePath: file.relativePath,
      isSolid: false,
      componentNames: [],
      signalCount: 0,
      effectCount: 0,
      memoCount: 0,
      resourceCount: 0,
      storeCount: 0,
      produceCount: 0,
      useParamsCount: 0,
      useNavigateCount: 0,
      useLocationCount: 0,
      showCount: 0,
      forCount: 0,
      switchCount: 0,
      matchCount: 0,
      indexCount: 0,
      dynamicCount: 0,
      suspenseCount: 0,
      errorBoundaryCount: 0,
      lazyCount: 0,
    };
  }

  // Component names
  const componentNames: string[] = [];
  const compRe = new RegExp(EXPORT_COMPONENT_RE.source, EXPORT_COMPONENT_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = compRe.exec(content)) !== null) {
    componentNames.push(match[1]!);
  }

  return {
    filePath: file.relativePath,
    isSolid: true,
    componentNames,
    signalCount: countMatches(content, CREATE_SIGNAL_RE),
    effectCount: countMatches(content, CREATE_EFFECT_RE),
    memoCount: countMatches(content, CREATE_MEMO_RE),
    resourceCount: countMatches(content, CREATE_RESOURCE_RE),
    storeCount: countMatches(content, CREATE_STORE_RE),
    produceCount: countMatches(content, PRODUCE_RE),
    useParamsCount: countMatches(content, USE_PARAMS_RE),
    useNavigateCount: countMatches(content, USE_NAVIGATE_RE),
    useLocationCount: countMatches(content, USE_LOCATION_RE),
    showCount: countMatches(content, SHOW_RE),
    forCount: countMatches(content, FOR_RE),
    switchCount: countMatches(content, SWITCH_RE),
    matchCount: countMatches(content, MATCH_RE),
    indexCount: countMatches(content, INDEX_RE),
    dynamicCount: countMatches(content, DYNAMIC_RE),
    suspenseCount: countMatches(content, SUSPENSE_RE),
    errorBoundaryCount: countMatches(content, ERROR_BOUNDARY_RE),
    lazyCount: countMatches(content, LAZY_RE),
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

function computeOutputHash(
  patterns: readonly PatternResult[],
  diagnostics: readonly AnalyzerDiagnostic[],
): OutputHash {
  const payload = stableStringify({ patterns, diagnostics });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
