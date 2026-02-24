// Config
export type { UIQuarterConfig } from "./types/index.js";

// Branded types
export type {
  FileHash,
  AnalyzerId,
  PatternId,
  CacheKey,
  OutputHash,
} from "./types/index.js";

// File system
export type { DiscoveredFile, SourceLocation, SourceSpan } from "./types/index.js";

// Cache
export type { CacheEntry, CacheAccessor } from "./types/index.js";

// Pattern & confidence
export type {
  ConfidenceScore,
  ConfidenceFactor,
  PatternType,
  PatternResult,
  PatternProperty,
} from "./types/index.js";

// Analyzer
export type {
  DiagnosticSeverity,
  AnalyzerDiagnostic,
  AnalyzerContext,
  AnalyzerOutput,
  AnalyzerStats,
  Analyzer,
} from "./types/index.js";

// Intelligence index
export type {
  DependencyEdge,
  IntelligenceIndex,
  IndexStats,
} from "./types/index.js";

// Resolver
export type {
  ResolverQueryKind,
  ResolverQuery,
  ResolvedContext,
} from "./types/index.js";

// Insights
export type {
  Insight,
  InsightType,
  InsightSeverity,
  InsightEngineResult,
} from "./types/index.js";

// Cache
export { CacheLayer } from "./cache/index.js";
export type { CacheLayerOptions } from "./cache/index.js";

// Core
export { createContext } from "./core/index.js";
export { FileDiscovery } from "./core/index.js";
export { AnalyzerOrchestrator } from "./core/index.js";
export { InsightEngine } from "./core/InsightEngine.js";
export { normalizeOutput, DEFAULT_METADATA_KEY_MAP } from "./core/index.js";
export type { CoreContext } from "./core/index.js";
export type { FileDiscoveryOptions } from "./core/index.js";
export type {
  OrchestratorOptions,
  OrchestratorResult,
  OrchestratorError,
  OrchestratorErrorPhase,
} from "./core/index.js";
export type { NormalizerOptions, MetadataMapping } from "./core/index.js";
export { CURRENT_SCHEMA_VERSION, checkSchemaVersion, migrateSchema } from "./core/index.js";
export type { MigrationCheckResult } from "./core/index.js";

// Indexer
export { IntelligenceIndexer } from "./indexer/index.js";
export type { IndexerOptions, IndexMeta } from "./indexer/index.js";

// Query
export { QueryEngine } from "./query/QueryEngine.js";
export { InvertedIndex } from "./query/InvertedIndex.js";
export type { MatchKind, TokenMatch, SearchMatch } from "./query/InvertedIndex.js";
export { ResolverScorer } from "./query/ResolverScorer.js";
export type { ScoredMatch, MatchDetail } from "./query/ResolverScorer.js";

// AI / Prompt
export { PromptBuilder } from "./ai/PromptBuilder.js";
export { BudgetPromptBuilder } from "./ai/BudgetPromptBuilder.js";

// Analyzers — Core
export { StructureAnalyzer } from "./analyzers/index.js";
export { ImportAnalyzer } from "./analyzers/index.js";
export { ComponentAnalyzer } from "./analyzers/index.js";
export { StylingAnalyzer } from "./analyzers/index.js";
export { FileStructureAnalyzer } from "./analyzers/index.js";
export { DependencyAnalyzer } from "./analyzers/index.js";
export { UxAnalyzer } from "./analyzers/index.js";

// Analyzers — Framework
export { NextjsAnalyzer } from "./analyzers/index.js";
export { NuxtAnalyzer } from "./analyzers/index.js";
export { SvelteKitAnalyzer } from "./analyzers/index.js";
export { AngularAnalyzer } from "./analyzers/index.js";
export { SolidAnalyzer } from "./analyzers/index.js";
export { LitAnalyzer } from "./analyzers/index.js";
export { QwikAnalyzer } from "./analyzers/index.js";

// Analyzers — Backend
export { ApiRouteAnalyzer } from "./analyzers/index.js";
export { DatabaseAnalyzer } from "./analyzers/index.js";
export { AuthAnalyzer } from "./analyzers/index.js";
export { EnvConfigAnalyzer } from "./analyzers/index.js";

// Analyzers — Quality
export { CoverageAnalyzer } from "./analyzers/index.js";
export { PerformanceAnalyzer } from "./analyzers/index.js";

// Generate
export { getTargetConfig, getAllTargetNames, getAllTargetConfigs } from "./generate/index.js";
export type {
  GenerateTargetName,
  GeneratedFile,
  GeneratorContext,
  ConventionContext,
  FormatterOptions,
  TargetFormatter,
  TargetConfig,
  GenerateCommandOptions,
} from "./generate/index.js";

// Context
export { ContextBuilder } from "./context/ContextBuilder.js";
export type { ProjectContext, ComponentContext, InsightContext, ChainContext, HubContext } from "./context/ContextBuilder.js";
export { TaskScopedBuilder } from "./context/TaskScopedBuilder.js";
export type { TaskScopedContext, TaskMatch, RelatedComponent, ScopedInsight, TaskScopedOptions } from "./context/TaskScopedBuilder.js";

// MCP
export { McpServer } from "./mcp/index.js";
export type { McpServerOptions, Transport } from "./mcp/index.js";
export { StdioTransport, HttpTransport, createHandlers } from "./mcp/index.js";
export type {
  McpToolDefinition,
  McpToolResult,
  McpContent,
  McpResourceDefinition,
  McpResourceResult,
  RegisteredTool,
  RegisteredResource,
} from "./mcp/index.js";

// Drift
export { loadSnapshot, computeDrift, formatDriftText, formatDriftMarkdown, formatDriftJson } from "./drift/index.js";
export type { DriftSnapshot, DriftReport, PatternDiff, InsightDiff, StatsDiff } from "./drift/index.js";

// CI
export { generateCiReport, generateGithubActionTemplate } from "./ci/index.js";
export type { CiReportOptions, CiReportResult, CiFailLevel } from "./ci/index.js";
export { postPrComment, isGhAvailable, buildCommentBody, COMMENT_MARKER } from "./ci/index.js";
export type { PrCommentOptions } from "./ci/index.js";

// Conventions
export { ConventionChecker, formatViolationsText, formatViolationsMarkdown, formatViolationsJson } from "./conventions/ConventionChecker.js";
export type { ConventionViolation, ConventionCheckResult, UiqrcConfig } from "./conventions/types.js";

// Report
export { generateHtmlReport } from "./report/HtmlReporter.js";
export type { ReportData } from "./report/HtmlReporter.js";
