// Branded primitives
export type {
  FileHash,
  AnalyzerId,
  PatternId,
  CacheKey,
  OutputHash,
} from "./brand.js";

// File system
export type { DiscoveredFile, SourceLocation, SourceSpan } from "./file.js";

// Cache
export type { CacheEntry, CacheAccessor } from "./cache.js";

// Pattern & confidence
export type {
  ConfidenceScore,
  ConfidenceFactor,
  PatternType,
  PatternResult,
  PatternProperty,
} from "./pattern.js";

// Analyzer
export type {
  DiagnosticSeverity,
  AnalyzerDiagnostic,
  AnalyzerContext,
  AnalyzerOutput,
  AnalyzerStats,
  Analyzer,
} from "./analyzer.js";

// Intelligence index
export type {
  DependencyEdge,
  IntelligenceIndex,
  IndexStats,
} from "./intelligence.js";

// Resolver
export type {
  ResolverQueryKind,
  ResolverQuery,
  ResolvedContext,
} from "./resolver.js";

// Insights
export type {
  Insight,
  InsightType,
  InsightSeverity,
  InsightEngineResult,
} from "./insight.js";

// Config (kept from v1 — still used by CLI and core context)
export interface UIQuarterConfig {
  rootDir: string;
  outDir: string;
  frameworks: string[];
  watch: boolean;
  cache: boolean;
}
