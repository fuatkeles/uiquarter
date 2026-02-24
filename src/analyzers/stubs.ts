import { createHash } from "node:crypto";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerOutput,
  AnalyzerId,
  PatternResult,
  PatternId,
  PatternType,
  OutputHash,
  DiscoveredFile,
} from "../types/index.js";

// -----------------------------------------------------------------------------
// StructureAnalyzer — file-structure heuristic
// -----------------------------------------------------------------------------

const COMPONENT_EXTENSIONS = new Set(["tsx", "jsx", "vue", "svelte"]);
const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "vue", "svelte"]);

/**
 * Stub analyzer that classifies files by name and extension.
 *
 * This is NOT a real analyzer — it uses filename heuristics only.
 * It exists to validate the full pipeline (FileDiscovery → Orchestrator →
 * Normalizer → Cache → Indexer) without requiring AST parsing.
 *
 * Rules:
 *   .tsx / .jsx / .vue / .svelte → type "component"
 *   .ts / .js                    → type "utility"
 *   Framework: .vue → "vue", .svelte → "svelte", else "react"
 *   Confidence: 0.5 (low — filename heuristic only)
 */
/**
 * @deprecated Superseded by ComponentAnalyzer + FileStructureAnalyzer.
 * Retained for backward compatibility — will be removed in v1.0.
 */
export class StructureAnalyzer implements Analyzer {
  readonly name = "structure";
  readonly version = "0.1.0";
  readonly capabilities = ["file-structure"] as const;
  readonly deprecated = true;

  fileFilter(file: DiscoveredFile): boolean {
    return SOURCE_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];

    for (const file of context.files) {
      const name = extractName(file.relativePath);
      const type = inferType(file.extension);
      const framework = inferFramework(file.extension);
      const id = `${file.relativePath}:${name}:1` as PatternId;

      patterns.push({
        id,
        type,
        name,
        filePath: file.relativePath,
        location: {
          file: file.relativePath,
          start: { line: 1, column: 0 },
          end: { line: 1, column: 0 },
        },
        confidence: {
          value: 0.5,
          source: "filename-heuristic",
          factors: [{ name: "extension", weight: 1, score: 0.5 }],
        },
        framework,
        dependencies: [],
        properties: {},
        metadata: {},
      });
    }

    // Sort patterns by id for determinism
    patterns.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const duration = Date.now() - start;
    const diagnostics: AnalyzerDiagnostic[] = [
      {
        severity: "info",
        filePath: ".",
        message: "STR001 StructureAnalyzer is deprecated — superseded by ComponentAnalyzer + FileStructureAnalyzer",
        line: 1,
        column: 0,
      },
    ];
    const hash = computeHash(patterns, diagnostics);

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash,
      duration,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: context.files.length,
        cacheHits: 0,
        cacheMisses: context.files.length,
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractName(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const fileName = parts[parts.length - 1] ?? "";
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
}

function inferType(extension: string): PatternType {
  return COMPONENT_EXTENSIONS.has(extension) ? "component" : "utility";
}

function inferFramework(extension: string): string {
  if (extension === "vue") return "vue";
  if (extension === "svelte") return "svelte";
  return "react";
}

function computeHash(patterns: readonly PatternResult[], diagnostics: readonly AnalyzerDiagnostic[] = []): OutputHash {
  const payload = JSON.stringify({ patterns, diagnostics });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
