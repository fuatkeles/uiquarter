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
// Constants
// -----------------------------------------------------------------------------

/** Coverage file names we care about */
const COVERAGE_FILES = new Set([
  "lcov.info",
  "coverage-summary.json",
  "clover.xml",
]);

// LCOV format is parsed inline using string matching in parseLcov()

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface FileCoverage {
  readonly sourceFile: string;
  readonly linesHit: number;
  readonly linesFound: number;
  readonly branchesHit: number;
  readonly branchesFound: number;
  readonly lineRate: number;
  readonly branchRate: number;
}

interface CoverageFileMetrics {
  readonly filePath: string;
  readonly format: "lcov" | "istanbul" | "clover" | "unknown";
  readonly fileCoverages: readonly FileCoverage[];
  readonly totalLineRate: number;
  readonly totalBranchRate: number;
}

// -----------------------------------------------------------------------------
// CoverageAnalyzer
// -----------------------------------------------------------------------------

export class CoverageAnalyzer implements Analyzer {
  readonly name = "coverage";
  readonly version = "1.0.0";
  readonly capabilities = [
    "lcov-parsing",
    "istanbul-parsing",
    "per-file-coverage",
    "coverage-summary",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    const normPath = file.relativePath.replace(/\\/g, "/");
    const fileName = normPath.split("/").pop() ?? "";

    // Known coverage file names
    if (COVERAGE_FILES.has(fileName)) return true;

    // Files inside a coverage/ directory
    if (/(?:^|\/)coverage\//.test(normPath)) return true;

    return false;
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: CoverageFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `coverage:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<CoverageFileMetrics>(cacheKey);
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

      const metrics = analyzeCoverageFile(file, content);
      if (metrics.format !== "unknown") {
        allMetrics.push(metrics);
        context.cache.set(cacheKey, metrics, file.hash as FileHash);
      }
    }

    // If no coverage files found, produce empty summary
    if (allMetrics.length === 0) {
      const summaryId = `.:coverage-summary:1` as PatternId;
      patterns.push({
        id: summaryId,
        type: "utility" as PatternType,
        name: "coverage-summary",
        filePath: ".",
        location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: 0.5,
          source: "coverage-analysis",
          factors: [{ name: "no-coverage-data", weight: 1, score: 0.5 }],
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          totalCoveragePercent: 0,
          filesCovered: 0,
          totalLinesHit: 0,
          totalLinesFound: 0,
          hasCoverageData: false,
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

    // Aggregate all file coverages from all report files
    const allFileCoverages: FileCoverage[] = [];
    for (const m of allMetrics) {
      for (const fc of m.fileCoverages) {
        allFileCoverages.push(fc);
      }
    }

    // Deduplicate by source file (keep last occurrence)
    const coverageByFile = new Map<string, FileCoverage>();
    for (const fc of allFileCoverages) {
      coverageByFile.set(fc.sourceFile, fc);
    }

    // Per-file coverage patterns
    let totalLinesHit = 0;
    let totalLinesFound = 0;
    let totalBranchesHit = 0;
    let totalBranchesFound = 0;

    for (const [sourceFile, fc] of [...coverageByFile.entries()].sort((a, b) => compare(a[0], b[0]))) {
      totalLinesHit += fc.linesHit;
      totalLinesFound += fc.linesFound;
      totalBranchesHit += fc.branchesHit;
      totalBranchesFound += fc.branchesFound;

      const pid = `${sourceFile}:coverage:1` as PatternId;
      patterns.push({
        id: pid,
        type: "utility" as PatternType,
        name: `coverage:${extractFileNameFromPath(sourceFile)}`,
        filePath: sourceFile,
        location: { file: sourceFile, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: 0.95,
          source: "coverage-data",
          factors: [{ name: "coverage-report", weight: 1, score: 0.95 }],
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          lineRate: fc.lineRate,
          branchRate: fc.branchRate,
          linesHit: fc.linesHit,
          linesFound: fc.linesFound,
          branchesHit: fc.branchesHit,
          branchesFound: fc.branchesFound,
        },
      });
    }

    // Summary pattern
    const totalCoveragePercent = totalLinesFound > 0
      ? Math.round((totalLinesHit / totalLinesFound) * 10000) / 100
      : 0;
    const totalBranchPercent = totalBranchesFound > 0
      ? Math.round((totalBranchesHit / totalBranchesFound) * 10000) / 100
      : 0;

    const summaryId = `.:coverage-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "coverage-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.95,
        source: "coverage-analysis",
        factors: [{ name: "coverage-aggregation", weight: 1, score: 0.95 }],
      },
      framework: "generic",
      dependencies: [],
      properties: {},
      metadata: {
        totalCoveragePercent,
        totalBranchPercent,
        filesCovered: coverageByFile.size,
        totalLinesHit,
        totalLinesFound,
        totalBranchesHit,
        totalBranchesFound,
        hasCoverageData: true,
        reportFormats: [...new Set(allMetrics.map((m) => m.format))].sort(),
      },
    });

    // Diagnostics for low coverage
    if (totalCoveragePercent < 50 && coverageByFile.size > 0) {
      diagnostics.push({
        severity: "warning",
        filePath: ".",
        message: `COV001 Overall line coverage is ${totalCoveragePercent}%, below 50% threshold.`,
      });
    }

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

function analyzeCoverageFile(file: DiscoveredFile, content: string): CoverageFileMetrics {
  const normPath = file.relativePath.replace(/\\/g, "/");
  const fileName = normPath.split("/").pop() ?? "";

  // Determine format
  if (fileName === "lcov.info" || content.trimStart().startsWith("TN:") || /^SF:/m.test(content)) {
    return parseLcov(file, content);
  }

  if (fileName === "coverage-summary.json" || (fileName.endsWith(".json") && content.includes('"total"'))) {
    return parseIstanbul(file, content);
  }

  if (fileName === "clover.xml" || content.includes("<coverage")) {
    return parseCloverXml(file, content);
  }

  return {
    filePath: file.relativePath,
    format: "unknown",
    fileCoverages: [],
    totalLineRate: 0,
    totalBranchRate: 0,
  };
}

function parseLcov(file: DiscoveredFile, content: string): CoverageFileMetrics {
  const fileCoverages: FileCoverage[] = [];

  // Split content into records (between SF: and end_of_record)
  const records = content.split(/end_of_record/);

  for (const record of records) {
    const sfMatch = record.match(/^SF:(.+)$/m);
    if (!sfMatch) continue;

    const sourceFile = sfMatch[1]!.trim();

    const lhMatch = record.match(/^LH:(\d+)$/m);
    const lfMatch = record.match(/^LF:(\d+)$/m);
    const brhMatch = record.match(/^BRH:(\d+)$/m);
    const brfMatch = record.match(/^BRF:(\d+)$/m);

    const linesHit = lhMatch ? parseInt(lhMatch[1]!, 10) : 0;
    const linesFound = lfMatch ? parseInt(lfMatch[1]!, 10) : 0;
    const branchesHit = brhMatch ? parseInt(brhMatch[1]!, 10) : 0;
    const branchesFound = brfMatch ? parseInt(brfMatch[1]!, 10) : 0;

    const lineRate = linesFound > 0 ? Math.round((linesHit / linesFound) * 10000) / 10000 : 0;
    const branchRate = branchesFound > 0 ? Math.round((branchesHit / branchesFound) * 10000) / 10000 : 0;

    fileCoverages.push({
      sourceFile,
      linesHit,
      linesFound,
      branchesHit,
      branchesFound,
      lineRate,
      branchRate,
    });
  }

  // Compute overall
  let totalHit = 0;
  let totalFound = 0;
  for (const fc of fileCoverages) {
    totalHit += fc.linesHit;
    totalFound += fc.linesFound;
  }

  return {
    filePath: file.relativePath,
    format: "lcov",
    fileCoverages,
    totalLineRate: totalFound > 0 ? totalHit / totalFound : 0,
    totalBranchRate: 0,
  };
}

function parseIstanbul(file: DiscoveredFile, content: string): CoverageFileMetrics {
  const fileCoverages: FileCoverage[] = [];

  try {
    const data = JSON.parse(content) as Record<string, unknown>;

    // Istanbul coverage-summary.json has { total: { lines: { pct: N } }, file: { ... } }
    if (data["total"] && typeof data["total"] === "object") {
      const total = data["total"] as Record<string, unknown>;

      for (const [key, val] of Object.entries(data)) {
        if (key === "total") continue;
        if (val && typeof val === "object") {
          const entry = val as Record<string, unknown>;
          const lines = entry["lines"] as Record<string, number> | undefined;
          const branches = entry["branches"] as Record<string, number> | undefined;

          if (lines && typeof lines === "object") {
            const linesHit = typeof lines["covered"] === "number" ? lines["covered"] : 0;
            const linesFound = typeof lines["total"] === "number" ? lines["total"] : 0;
            const branchesHit = branches && typeof branches["covered"] === "number" ? branches["covered"] : 0;
            const branchesFound = branches && typeof branches["total"] === "number" ? branches["total"] : 0;

            fileCoverages.push({
              sourceFile: key,
              linesHit,
              linesFound,
              branchesHit,
              branchesFound,
              lineRate: linesFound > 0 ? Math.round((linesHit / linesFound) * 10000) / 10000 : 0,
              branchRate: branchesFound > 0 ? Math.round((branchesHit / branchesFound) * 10000) / 10000 : 0,
            });
          }
        }
      }

      const totalLines = total["lines"] as Record<string, number> | undefined;
      const totalPct = totalLines && typeof totalLines["pct"] === "number" ? totalLines["pct"] / 100 : 0;

      return {
        filePath: file.relativePath,
        format: "istanbul",
        fileCoverages,
        totalLineRate: totalPct,
        totalBranchRate: 0,
      };
    }
  } catch {
    // Failed to parse JSON
  }

  return {
    filePath: file.relativePath,
    format: "istanbul",
    fileCoverages,
    totalLineRate: 0,
    totalBranchRate: 0,
  };
}

function parseCloverXml(file: DiscoveredFile, content: string): CoverageFileMetrics {
  // Simple regex-based parsing for clover XML
  const fileCoverages: FileCoverage[] = [];

  const fileRe = /<file\s+[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g;
  let match: RegExpExecArray | null;

  while ((match = fileRe.exec(content)) !== null) {
    const sourceFile = match[1]!;
    const body = match[2]!;

    // <metrics ... statements="N" coveredstatements="M" />
    const metricsMatch = body.match(/<metrics[^>]*\/>/);
    if (metricsMatch) {
      const m = metricsMatch[0];
      const stmts = m.match(/statements="(\d+)"/);
      const covStmts = m.match(/coveredstatements="(\d+)"/);
      const conds = m.match(/conditionals="(\d+)"/);
      const covConds = m.match(/coveredconditionals="(\d+)"/);

      const linesFound = stmts ? parseInt(stmts[1]!, 10) : 0;
      const linesHit = covStmts ? parseInt(covStmts[1]!, 10) : 0;
      const branchesFound = conds ? parseInt(conds[1]!, 10) : 0;
      const branchesHit = covConds ? parseInt(covConds[1]!, 10) : 0;

      fileCoverages.push({
        sourceFile,
        linesHit,
        linesFound,
        branchesHit,
        branchesFound,
        lineRate: linesFound > 0 ? Math.round((linesHit / linesFound) * 10000) / 10000 : 0,
        branchRate: branchesFound > 0 ? Math.round((branchesHit / branchesFound) * 10000) / 10000 : 0,
      });
    }
  }

  let totalHit = 0;
  let totalFound = 0;
  for (const fc of fileCoverages) {
    totalHit += fc.linesHit;
    totalFound += fc.linesFound;
  }

  return {
    filePath: file.relativePath,
    format: "clover",
    fileCoverages,
    totalLineRate: totalFound > 0 ? totalHit / totalFound : 0,
    totalBranchRate: 0,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractFileNameFromPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
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
