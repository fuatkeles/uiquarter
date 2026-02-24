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
// Internal types
// -----------------------------------------------------------------------------

interface ComponentPerfData {
  readonly name: string;
  readonly avgRenderMs: number;
  readonly renderCount: number;
}

interface LighthouseScores {
  readonly performanceScore: number;
  readonly lcp: number | null;
  readonly fid: number | null;
  readonly cls: number | null;
  readonly fcp: number | null;
  readonly tbt: number | null;
  readonly si: number | null;
}

interface PerfFileMetrics {
  readonly filePath: string;
  readonly format: "react-profiler" | "lighthouse" | "custom" | "unknown";
  readonly components: readonly ComponentPerfData[];
  readonly lighthouse: LighthouseScores | null;
}

// -----------------------------------------------------------------------------
// PerformanceAnalyzer
// -----------------------------------------------------------------------------

export class PerformanceAnalyzer implements Analyzer {
  readonly name = "performance";
  readonly version = "1.0.0";
  readonly capabilities = [
    "react-profiler-detection",
    "lighthouse-detection",
    "custom-profiler-detection",
    "render-time-analysis",
    "web-vitals-analysis",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return file.extension === "json";
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: PerfFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `performance:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<PerfFileMetrics>(cacheKey);
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

      const metrics = analyzePerfFile(file, content);
      if (metrics.format !== "unknown") {
        allMetrics.push(metrics);
        context.cache.set(cacheKey, metrics, file.hash as FileHash);
      }
    }

    // If no perf files found, produce empty summary
    if (allMetrics.length === 0) {
      const summaryId = `.:performance-summary:1` as PatternId;
      patterns.push({
        id: summaryId,
        type: "utility" as PatternType,
        name: "performance-summary",
        filePath: ".",
        location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: 0.5,
          source: "performance-analysis",
          factors: [{ name: "no-perf-data", weight: 1, score: 0.5 }],
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          totalProfiledComponents: 0,
          hasProfilerData: false,
          hasLighthouseData: false,
        },
      });

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
          analyzedFiles: 0,
          cacheHits,
          cacheMisses: 0,
        },
      };
    }

    // Aggregate all components from all sources
    const allComponents: ComponentPerfData[] = [];
    let lighthouseResult: LighthouseScores | null = null;

    for (const m of allMetrics) {
      for (const comp of m.components) {
        allComponents.push(comp);
      }
      if (m.lighthouse !== null) {
        lighthouseResult = m.lighthouse;
      }
    }

    // Deduplicate components by name (keep one with highest avgRenderMs)
    const componentMap = new Map<string, ComponentPerfData>();
    for (const comp of allComponents) {
      const existing = componentMap.get(comp.name);
      if (!existing || comp.avgRenderMs > existing.avgRenderMs) {
        componentMap.set(comp.name, comp);
      }
    }

    // Per-component perf patterns
    const sortedComponents = [...componentMap.values()].sort((a, b) => compare(a.name, b.name));
    for (const comp of sortedComponents) {
      const pid = `${comp.name}:perf:1` as PatternId;
      patterns.push({
        id: pid,
        type: "utility" as PatternType,
        name: `perf:${comp.name}`,
        filePath: ".",
        location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: 0.9,
          source: "profiler-data",
          factors: [{ name: "profiler-measurement", weight: 1, score: 0.9 }],
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          avgRenderMs: comp.avgRenderMs,
          renderCount: comp.renderCount,
        },
      });
    }

    // Lighthouse patterns
    if (lighthouseResult !== null) {
      const lhId = `.:lighthouse:1` as PatternId;
      patterns.push({
        id: lhId,
        type: "utility" as PatternType,
        name: "lighthouse-scores",
        filePath: ".",
        location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: 0.95,
          source: "lighthouse-data",
          factors: [{ name: "lighthouse-report", weight: 1, score: 0.95 }],
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          performanceScore: lighthouseResult.performanceScore,
          lcp: lighthouseResult.lcp,
          fid: lighthouseResult.fid,
          cls: lighthouseResult.cls,
          fcp: lighthouseResult.fcp,
          tbt: lighthouseResult.tbt,
          si: lighthouseResult.si,
        },
      });

      // Diagnostic for low performance score
      if (lighthouseResult.performanceScore < 0.5) {
        diagnostics.push({
          severity: "warning",
          filePath: ".",
          message: `PERF001 Lighthouse performance score is ${Math.round(lighthouseResult.performanceScore * 100)}%, below 50% threshold.`,
        });
      }
    }

    // Find slowest components
    const byRenderTime = [...componentMap.values()].sort((a, b) => b.avgRenderMs - a.avgRenderMs);
    const slowest = byRenderTime.slice(0, 5).map((c) => ({
      name: c.name,
      avgRenderMs: c.avgRenderMs,
    }));

    // Diagnostics for slow components
    for (const comp of byRenderTime) {
      if (comp.avgRenderMs > 16) {
        diagnostics.push({
          severity: "warning",
          filePath: ".",
          message: `PERF002 Component '${comp.name}' has avg render time of ${comp.avgRenderMs.toFixed(1)}ms, exceeding 16ms frame budget.`,
        });
      }
    }

    // Summary pattern
    const summaryId = `.:performance-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "performance-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.9,
        source: "performance-analysis",
        factors: [{ name: "profiler-aggregation", weight: 1, score: 0.9 }],
      },
      framework: "generic",
      dependencies: [],
      properties: {},
      metadata: {
        totalProfiledComponents: componentMap.size,
        slowestComponents: slowest,
        hasProfilerData: allComponents.length > 0,
        hasLighthouseData: lighthouseResult !== null,
        lighthousePerformanceScore: lighthouseResult?.performanceScore ?? null,
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

function analyzePerfFile(file: DiscoveredFile, content: string): PerfFileMetrics {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {
      filePath: file.relativePath,
      format: "unknown",
      components: [],
      lighthouse: null,
    };
  }

  // React DevTools profiler export
  if (data["dataForRoots"] !== undefined || data["profilingDataForRoots"] !== undefined) {
    return parseReactProfiler(file, data);
  }

  // Lighthouse JSON report
  if (typeof data["lighthouseVersion"] === "string") {
    return parseLighthouse(file, data);
  }

  // Custom format: { components: [{ name, avgRenderMs, renderCount }] }
  if (Array.isArray(data["components"])) {
    return parseCustomProfiler(file, data);
  }

  return {
    filePath: file.relativePath,
    format: "unknown",
    components: [],
    lighthouse: null,
  };
}

function parseReactProfiler(
  file: DiscoveredFile,
  data: Record<string, unknown>,
): PerfFileMetrics {
  const components: ComponentPerfData[] = [];

  const roots = (data["dataForRoots"] ?? data["profilingDataForRoots"]) as unknown[];
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (root && typeof root === "object") {
        const rootObj = root as Record<string, unknown>;
        const commitData = rootObj["commitData"] as unknown[] | undefined;

        // Parse commit data format
        if (Array.isArray(commitData)) {
          const renderTimes = new Map<string, { total: number; count: number }>();
          for (const commit of commitData) {
            if (commit && typeof commit === "object") {
              const cd = commit as Record<string, unknown>;
              const fiberSelfDurations = cd["fiberSelfDurations"] as Map<number, number> | Record<string, number> | undefined;
              const fiberNames = cd["fiberNames"] as Map<number, string> | Record<string, string> | undefined;

              // Simplified extraction — actual React profiler format varies
              if (fiberSelfDurations && fiberNames) {
                const durations = fiberSelfDurations instanceof Map
                  ? Object.fromEntries(fiberSelfDurations)
                  : fiberSelfDurations as Record<string, number>;
                const names = fiberNames instanceof Map
                  ? Object.fromEntries(fiberNames)
                  : fiberNames as Record<string, string>;

                for (const [id, duration] of Object.entries(durations)) {
                  const name = names[id];
                  if (name && typeof duration === "number") {
                    const existing = renderTimes.get(name) ?? { total: 0, count: 0 };
                    renderTimes.set(name, {
                      total: existing.total + duration,
                      count: existing.count + 1,
                    });
                  }
                }
              }
            }
          }

          for (const [name, data] of renderTimes) {
            components.push({
              name,
              avgRenderMs: data.count > 0 ? Math.round((data.total / data.count) * 100) / 100 : 0,
              renderCount: data.count,
            });
          }
        }
      }
    }
  }

  return {
    filePath: file.relativePath,
    format: "react-profiler",
    components,
    lighthouse: null,
  };
}

function parseLighthouse(
  file: DiscoveredFile,
  data: Record<string, unknown>,
): PerfFileMetrics {
  const categories = data["categories"] as Record<string, unknown> | undefined;
  const audits = data["audits"] as Record<string, unknown> | undefined;

  let performanceScore = 0;
  if (categories && typeof categories === "object") {
    const perf = categories["performance"] as Record<string, unknown> | undefined;
    if (perf && typeof perf["score"] === "number") {
      performanceScore = perf["score"];
    }
  }

  let lcp: number | null = null;
  let fid: number | null = null;
  let cls: number | null = null;
  let fcp: number | null = null;
  let tbt: number | null = null;
  let si: number | null = null;

  if (audits && typeof audits === "object") {
    lcp = extractAuditValue(audits, "largest-contentful-paint");
    fid = extractAuditValue(audits, "max-potential-fid");
    cls = extractAuditValue(audits, "cumulative-layout-shift");
    fcp = extractAuditValue(audits, "first-contentful-paint");
    tbt = extractAuditValue(audits, "total-blocking-time");
    si = extractAuditValue(audits, "speed-index");
  }

  return {
    filePath: file.relativePath,
    format: "lighthouse",
    components: [],
    lighthouse: {
      performanceScore,
      lcp,
      fid,
      cls,
      fcp,
      tbt,
      si,
    },
  };
}

function parseCustomProfiler(
  file: DiscoveredFile,
  data: Record<string, unknown>,
): PerfFileMetrics {
  const components: ComponentPerfData[] = [];
  const rawComponents = data["components"] as unknown[];

  if (Array.isArray(rawComponents)) {
    for (const item of rawComponents) {
      if (item && typeof item === "object") {
        const comp = item as Record<string, unknown>;
        const name = typeof comp["name"] === "string" ? comp["name"] : null;
        const avgRenderMs = typeof comp["avgRenderMs"] === "number" ? comp["avgRenderMs"] : 0;
        const renderCount = typeof comp["renderCount"] === "number" ? comp["renderCount"] : 0;

        if (name) {
          components.push({ name, avgRenderMs, renderCount });
        }
      }
    }
  }

  return {
    filePath: file.relativePath,
    format: "custom",
    components,
    lighthouse: null,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractAuditValue(
  audits: Record<string, unknown>,
  auditId: string,
): number | null {
  const audit = audits[auditId] as Record<string, unknown> | undefined;
  if (audit && typeof audit["numericValue"] === "number") {
    return Math.round(audit["numericValue"] * 100) / 100;
  }
  return null;
}

function computeOutputHash(
  patterns: readonly PatternResult[],
  diagnostics: readonly AnalyzerDiagnostic[],
): OutputHash {
  const payload = stableStringify({ patterns, diagnostics });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
