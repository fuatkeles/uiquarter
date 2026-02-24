import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import {
  Project,
  SyntaxKind,
  ts,
  type SourceFile,
} from "ts-morph";
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

const UX_EXTENSIONS = new Set([
  "tsx", "jsx", "vue", "svelte", "ts", "js",
  "css", "scss", "sass", "less",
]);

/** ARIA attributes that indicate accessibility effort */
const ARIA_ATTRS = [
  "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden",
  "aria-live", "aria-role", "aria-expanded", "aria-controls",
  "aria-selected", "aria-checked", "aria-disabled", "aria-required",
  "aria-invalid", "aria-haspopup", "aria-modal", "aria-busy",
  "aria-current", "aria-pressed", "aria-valuenow", "aria-valuemin",
  "aria-valuemax",
];

const ROLE_ATTR = /\brole\s*=\s*["'][^"']+["']/g;
const ARIA_ATTR_RE = new RegExp(`\\b(${ARIA_ATTRS.join("|")})\\s*[=\\s{]`, "g");

/** Patterns that indicate error handling */
const ERROR_PATTERNS = [
  /\berror\s*[?:.]|isError|hasError|errorMessage|ErrorBoundary|error-boundary/i,
  /\bcatch\s*\(|\.catch\s*\(|onError|on-error/i,
  /\bfallback\s*[=:{]|FallbackComponent|fallback-component/i,
];

/** Patterns that indicate loading states */
const LOADING_PATTERNS = [
  /\bloading\s*[?:.]|isLoading|isLoaded|Skeleton|skeleton/i,
  /\bSuspense|suspense|LazyLoad|lazy-load|Spinner|spinner/i,
  /\bpending\s*[?:.]|isPending|isFetching/i,
];

/** Patterns that indicate empty states */
const EMPTY_STATE_PATTERNS = [
  /\bempty\s*[?:.]|isEmpty|noData|no-data|EmptyState|empty-state/i,
  /\bplaceholder|Placeholder\b/i,
];

/** Media query patterns — responsive design */
const MEDIA_QUERY_RE = /@media\s*\([^)]*\)/g;
const RESPONSIVE_CLASSES_RE = /\b(sm:|md:|lg:|xl:|2xl:)/g;
const BREAKPOINT_RE = /\b(max-width|min-width|max-height|min-height)\s*:/g;

/** Navigation patterns */
const NAV_PATTERNS = [
  /\b(Link|NavLink|RouterLink|NuxtLink|router-link|nuxt-link)\b/,
  /\b(useRouter|useRoute|useNavigation|useNavigate|useLocation|useParams)\b/,
  /\b(navigate|push|replace|go)\s*\(/,
  /<nav\b|<Nav\b/,
];

/** Design system consistency — naming patterns */
const COMPONENT_PREFIX_RE = /^(Ui|App|Base|Core|Custom|Shared|Common|Layout|Page)/;

// -----------------------------------------------------------------------------
// UxAnalyzer
// -----------------------------------------------------------------------------

/**
 * Framework-agnostic UI/UX pattern analyzer.
 *
 * Detects and scores:
 *   1. Accessibility patterns — aria-*, role attributes, semantic HTML
 *   2. Error/loading state coverage — which components handle edge states
 *   3. Responsive patterns — media queries, responsive utility classes
 *   4. Navigation structure — router/link usage patterns
 *   5. Design system consistency — naming conventions, component prefixes
 *
 * Depends on "component" analyzer to leverage discovered component metadata.
 */
/** Extensions that benefit from AST analysis (ts-morph can parse them) */
const AST_EXTENSIONS = new Set(["tsx", "jsx", "ts", "js"]);

export class UxAnalyzer implements Analyzer {
  readonly name = "ux";
  readonly version = "1.1.0";
  readonly capabilities = [
    "accessibility-detection",
    "error-state-detection",
    "loading-state-detection",
    "responsive-detection",
    "navigation-detection",
    "design-system-consistency",
  ] as const;
  readonly dependencies = [] as const;

  private project: Project | null = null;

  fileFilter(file: DiscoveredFile): boolean {
    return UX_EXTENSIONS.has(file.extension);
  }

  private ensureProject(): void {
    if (this.project !== null) return;
    this.project = new Project({
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
        allowJs: true,
      },
      useInMemoryFileSystem: true,
      skipFileDependencyResolution: true,
    });
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];

    // Collect per-file UX metrics
    const fileMetrics: FileUxMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      // Check cache
      const cacheKey = `ux:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<FileUxMetrics>(cacheKey);
      if (cached !== undefined) {
        fileMetrics.push(cached.value);
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
        // Try Windows path
        try {
          const { join } = await import("node:path");
          content = await readFile(join(context.rootPath, file.relativePath), "utf-8");
        } catch {
          continue;
        }
      }

      // Use AST analysis for TSX/JSX/TS/JS; regex fallback for CSS/Vue/Svelte
      let metrics: FileUxMetrics;
      if (AST_EXTENSIONS.has(file.extension)) {
        metrics = this.analyzeFileWithAst(file, content);
      } else {
        metrics = analyzeFileUxRegex(file, content);
      }
      fileMetrics.push(metrics);

      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Aggregate metrics and build patterns
    const aggregated = aggregateMetrics(fileMetrics);

    // Build UX summary pattern
    const summaryId = `.:ux-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "ux-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.9,
        source: "ux-analysis",
        factors: [{ name: "multi-signal", weight: 1, score: 0.9 }],
      },
      framework: "generic",
      dependencies: [],
      properties: {},
      metadata: {
        totalFiles: fileMetrics.length,
        filesWithAria: aggregated.filesWithAria,
        filesWithRoles: aggregated.filesWithRoles,
        ariaAttributeCount: aggregated.totalAriaAttrs,
        roleAttributeCount: aggregated.totalRoleAttrs,
        filesWithErrorHandling: aggregated.filesWithErrorHandling,
        filesWithLoadingStates: aggregated.filesWithLoadingStates,
        filesWithEmptyStates: aggregated.filesWithEmptyStates,
        filesWithMediaQueries: aggregated.filesWithMediaQueries,
        filesWithResponsiveClasses: aggregated.filesWithResponsiveClasses,
        filesWithNavigation: aggregated.filesWithNavigation,
        accessibilityCoverage: aggregated.accessibilityCoverage,
        errorStateCoverage: aggregated.errorStateCoverage,
        loadingStateCoverage: aggregated.loadingStateCoverage,
        responsiveCoverage: aggregated.responsiveCoverage,
        componentPrefixes: aggregated.componentPrefixes,
        dominantPrefix: aggregated.dominantPrefix,
        prefixConsistency: aggregated.prefixConsistency,
      },
    });

    // Build per-file patterns for files with notable UX signals
    for (const metrics of fileMetrics) {
      if (!metrics.hasSignals) continue;

      const fileId = `${metrics.filePath}:ux:1` as PatternId;
      patterns.push({
        id: fileId,
        type: "utility" as PatternType,
        name: `ux:${extractFileName(metrics.filePath)}`,
        filePath: metrics.filePath,
        location: { file: metrics.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: metrics.confidenceValue,
          source: "ux-analysis",
          factors: metrics.confidenceFactors,
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          ariaCount: metrics.ariaCount,
          roleCount: metrics.roleCount,
          hasErrorHandling: metrics.hasErrorHandling,
          hasLoadingState: metrics.hasLoadingState,
          hasEmptyState: metrics.hasEmptyState,
          mediaQueryCount: metrics.mediaQueryCount,
          responsiveClassCount: metrics.responsiveClassCount,
          hasNavigation: metrics.hasNavigation,
          sourcePatternId: summaryId,
        },
      });
    }

    // Generate diagnostics
    if (aggregated.accessibilityCoverage < 0.1 && fileMetrics.length > 0) {
      diagnostics.push({
        severity: "warning",
        filePath: ".",
        message: `UX001 Low accessibility coverage: only ${(aggregated.accessibilityCoverage * 100).toFixed(0)}% of component files use ARIA attributes`,
      });
    }

    if (aggregated.errorStateCoverage < 0.2 && fileMetrics.length > 5) {
      diagnostics.push({
        severity: "info",
        filePath: ".",
        message: `UX002 Low error-state coverage: only ${(aggregated.errorStateCoverage * 100).toFixed(0)}% of component files handle errors`,
      });
    }

    if (aggregated.loadingStateCoverage < 0.15 && fileMetrics.length > 5) {
      diagnostics.push({
        severity: "info",
        filePath: ".",
        message: `UX003 Low loading-state coverage: only ${(aggregated.loadingStateCoverage * 100).toFixed(0)}% of component files handle loading states`,
      });
    }

    if (aggregated.prefixConsistency < 0.5 && Object.keys(aggregated.componentPrefixes).length > 1) {
      diagnostics.push({
        severity: "info",
        filePath: ".",
        message: `UX004 Inconsistent component prefixes: ${Object.entries(aggregated.componentPrefixes).map(([k, v]) => `${k}(${v})`).join(", ")}`,
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
        analyzedFiles: fileMetrics.length,
        cacheHits,
        cacheMisses: fileMetrics.length - cacheHits,
      },
    };
  }

  /**
   * AST-based UX analysis for TSX/JSX/TS/JS files.
   * Uses ts-morph to traverse JSX attributes, variable declarations,
   * component references, and try-catch blocks for more accurate detection.
   */
  private analyzeFileWithAst(file: DiscoveredFile, content: string): FileUxMetrics {
    this.ensureProject();
    const filePath = file.relativePath;
    const isComponent = ["tsx", "jsx"].includes(file.extension);

    const sourceFilePath = `/ux-analysis/${filePath}`;
    let sourceFile: SourceFile;
    try {
      sourceFile = this.project!.createSourceFile(sourceFilePath, content, { overwrite: true });
    } catch {
      // If AST parse fails, fall back to regex
      return analyzeFileUxRegex(file, content);
    }

    try {
      // --- Accessibility: scan JSX attributes for aria-* and role ---
      let ariaCount = 0;
      let roleCount = 0;

      const jsxAttributes = sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute);
      for (const attr of jsxAttributes) {
        const name = attr.getNameNode().getText();
        if (name.startsWith("aria-")) {
          ariaCount++;
        } else if (name === "role") {
          roleCount++;
        }
      }

      // Also check spread attributes containing aria (e.g., {...ariaProps})
      // and JSX string literals with aria patterns won't false-positive from comments

      // --- Error handling: AST detection ---
      let hasErrorHandling = false;

      // Check for ErrorBoundary JSX elements
      const jsxOpenElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
      const jsxSelfClosing = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
      const allJsxTags = [
        ...jsxOpenElements.map((e) => e.getTagNameNode().getText()),
        ...jsxSelfClosing.map((e) => e.getTagNameNode().getText()),
      ];

      for (const tagName of allJsxTags) {
        if (/ErrorBoundary|error-boundary|FallbackComponent/i.test(tagName)) {
          hasErrorHandling = true;
          break;
        }
      }

      // Check for try-catch statements
      if (!hasErrorHandling) {
        const tryCatch = sourceFile.getDescendantsOfKind(SyntaxKind.TryStatement);
        if (tryCatch.length > 0) hasErrorHandling = true;
      }

      // Check for error-related variable identifiers
      if (!hasErrorHandling) {
        const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
        for (const id of identifiers) {
          const text = id.getText();
          if (/^(isError|hasError|errorMessage|onError)$/.test(text)) {
            hasErrorHandling = true;
            break;
          }
        }
      }

      // Check .catch() calls
      if (!hasErrorHandling) {
        const callExprs = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const call of callExprs) {
          const expr = call.getExpression();
          if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propName = expr.asKind(SyntaxKind.PropertyAccessExpression)?.getName();
            if (propName === "catch") {
              hasErrorHandling = true;
              break;
            }
          }
        }
      }

      // --- Loading state: AST detection ---
      let hasLoadingState = false;

      // Check for Suspense/Skeleton/Spinner/LazyLoad JSX elements
      for (const tagName of allJsxTags) {
        if (/Suspense|Skeleton|Spinner|LazyLoad|Loading/i.test(tagName)) {
          hasLoadingState = true;
          break;
        }
      }

      // Check for loading-related identifiers
      if (!hasLoadingState) {
        const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
        for (const id of identifiers) {
          const text = id.getText();
          if (/^(isLoading|isLoaded|isPending|isFetching)$/.test(text)) {
            hasLoadingState = true;
            break;
          }
        }
      }

      // --- Empty state: AST detection ---
      let hasEmptyState = false;
      for (const tagName of allJsxTags) {
        if (/EmptyState|empty-state|Placeholder|NoData/i.test(tagName)) {
          hasEmptyState = true;
          break;
        }
      }
      if (!hasEmptyState) {
        const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
        for (const id of identifiers) {
          const text = id.getText();
          if (/^(isEmpty|noData|hasData)$/.test(text)) {
            hasEmptyState = true;
            break;
          }
        }
      }

      // --- Responsive: use regex on content (CSS-in-JS media queries, Tailwind classes) ---
      const mediaQueries = content.match(MEDIA_QUERY_RE) ?? [];
      const responsiveClasses = content.match(RESPONSIVE_CLASSES_RE) ?? [];
      const breakpoints = content.match(BREAKPOINT_RE) ?? [];
      const mediaQueryCount = mediaQueries.length + breakpoints.length;
      const responsiveClassCount = responsiveClasses.length;

      // --- Navigation: AST detection ---
      let hasNavigation = false;
      for (const tagName of allJsxTags) {
        if (/^(Link|NavLink|RouterLink|NuxtLink|nav|Nav)$/.test(tagName)) {
          hasNavigation = true;
          break;
        }
      }
      if (!hasNavigation) {
        const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
        for (const id of identifiers) {
          const text = id.getText();
          if (/^(useRouter|useRoute|useNavigation|useNavigate|useLocation|useParams)$/.test(text)) {
            hasNavigation = true;
            break;
          }
        }
      }

      // --- Component prefix ---
      const fileName = extractFileName(file.relativePath);
      const prefixMatch = fileName.match(COMPONENT_PREFIX_RE);
      const componentPrefix = isComponent && prefixMatch !== null ? prefixMatch[1]! : null;

      // --- Compute signals ---
      const hasSignals = isComponent && (
        ariaCount > 0 ||
        roleCount > 0 ||
        hasErrorHandling ||
        hasLoadingState ||
        hasEmptyState ||
        mediaQueryCount > 0 ||
        responsiveClassCount > 0 ||
        hasNavigation
      );

      const signalCount = [
        ariaCount > 0, roleCount > 0, hasErrorHandling, hasLoadingState,
        hasEmptyState, mediaQueryCount > 0, responsiveClassCount > 0, hasNavigation,
      ].filter(Boolean).length;

      const confidenceValue = Math.min(0.3 + signalCount * 0.1, 0.95);
      const factors = buildConfidenceFactors(
        ariaCount, roleCount, hasErrorHandling, hasLoadingState,
        mediaQueryCount, responsiveClassCount, hasNavigation,
      );

      return {
        filePath,
        hasSignals,
        confidenceValue,
        confidenceFactors: factors,
        ariaCount,
        roleCount,
        hasErrorHandling,
        hasLoadingState,
        hasEmptyState,
        mediaQueryCount,
        responsiveClassCount,
        hasNavigation,
        componentPrefix,
      };
    } finally {
      sourceFile.forget();
    }
  }
}

// -----------------------------------------------------------------------------
// Per-file UX analysis
// -----------------------------------------------------------------------------

interface FileUxMetrics {
  readonly filePath: string;
  readonly hasSignals: boolean;
  readonly confidenceValue: number;
  readonly confidenceFactors: readonly { name: string; weight: number; score: number }[];

  // Accessibility
  readonly ariaCount: number;
  readonly roleCount: number;

  // State handling
  readonly hasErrorHandling: boolean;
  readonly hasLoadingState: boolean;
  readonly hasEmptyState: boolean;

  // Responsive
  readonly mediaQueryCount: number;
  readonly responsiveClassCount: number;

  // Navigation
  readonly hasNavigation: boolean;

  // Component naming
  readonly componentPrefix: string | null;
}

/**
 * Regex-based UX analysis — used for CSS/SCSS/LESS/Vue/Svelte files
 * where ts-morph AST traversal is not applicable.
 */
function analyzeFileUxRegex(file: DiscoveredFile, content: string): FileUxMetrics {
  const isComponent = ["tsx", "jsx", "vue", "svelte"].includes(file.extension);

  // Accessibility
  const ariaMatches = content.match(ARIA_ATTR_RE) ?? [];
  const roleMatches = content.match(ROLE_ATTR) ?? [];
  const ariaCount = ariaMatches.length;
  const roleCount = roleMatches.length;

  // Error/loading states
  const hasErrorHandling = ERROR_PATTERNS.some((re) => re.test(content));
  const hasLoadingState = LOADING_PATTERNS.some((re) => re.test(content));
  const hasEmptyState = EMPTY_STATE_PATTERNS.some((re) => re.test(content));

  // Responsive
  const mediaQueries = content.match(MEDIA_QUERY_RE) ?? [];
  const responsiveClasses = content.match(RESPONSIVE_CLASSES_RE) ?? [];
  const breakpoints = content.match(BREAKPOINT_RE) ?? [];
  const mediaQueryCount = mediaQueries.length + breakpoints.length;
  const responsiveClassCount = responsiveClasses.length;

  // Navigation
  const hasNavigation = NAV_PATTERNS.some((re) => re.test(content));

  // Component prefix
  const fileName = extractFileName(file.relativePath);
  const prefixMatch = fileName.match(COMPONENT_PREFIX_RE);
  const componentPrefix = isComponent && prefixMatch !== null ? prefixMatch[1]! : null;

  // Determine if this file has notable UX signals
  const hasSignals = isComponent && (
    ariaCount > 0 ||
    roleCount > 0 ||
    hasErrorHandling ||
    hasLoadingState ||
    hasEmptyState ||
    mediaQueryCount > 0 ||
    responsiveClassCount > 0 ||
    hasNavigation
  );

  // Compute confidence based on signal diversity
  const signalCount = [
    ariaCount > 0, roleCount > 0, hasErrorHandling, hasLoadingState,
    hasEmptyState, mediaQueryCount > 0, responsiveClassCount > 0, hasNavigation,
  ].filter(Boolean).length;

  const confidenceValue = Math.min(0.3 + signalCount * 0.1, 0.95);
  const factors = buildConfidenceFactors(
    ariaCount, roleCount, hasErrorHandling, hasLoadingState,
    mediaQueryCount, responsiveClassCount, hasNavigation,
  );

  return {
    filePath: file.relativePath,
    hasSignals,
    confidenceValue,
    confidenceFactors: factors,
    ariaCount,
    roleCount,
    hasErrorHandling,
    hasLoadingState,
    hasEmptyState,
    mediaQueryCount,
    responsiveClassCount,
    hasNavigation,
    componentPrefix,
  };
}

// -----------------------------------------------------------------------------
// Aggregation
// -----------------------------------------------------------------------------

interface AggregatedMetrics {
  readonly filesWithAria: number;
  readonly filesWithRoles: number;
  readonly totalAriaAttrs: number;
  readonly totalRoleAttrs: number;
  readonly filesWithErrorHandling: number;
  readonly filesWithLoadingStates: number;
  readonly filesWithEmptyStates: number;
  readonly filesWithMediaQueries: number;
  readonly filesWithResponsiveClasses: number;
  readonly filesWithNavigation: number;
  readonly accessibilityCoverage: number;
  readonly errorStateCoverage: number;
  readonly loadingStateCoverage: number;
  readonly responsiveCoverage: number;
  readonly componentPrefixes: Readonly<Record<string, number>>;
  readonly dominantPrefix: string | null;
  readonly prefixConsistency: number;
}

function aggregateMetrics(metrics: readonly FileUxMetrics[]): AggregatedMetrics {
  const componentFiles = metrics.filter((m) => m.hasSignals || m.componentPrefix !== null);
  const total = componentFiles.length || 1; // avoid division by zero

  let filesWithAria = 0;
  let filesWithRoles = 0;
  let totalAriaAttrs = 0;
  let totalRoleAttrs = 0;
  let filesWithErrorHandling = 0;
  let filesWithLoadingStates = 0;
  let filesWithEmptyStates = 0;
  let filesWithMediaQueries = 0;
  let filesWithResponsiveClasses = 0;
  let filesWithNavigation = 0;
  const prefixCounts: Record<string, number> = {};

  for (const m of metrics) {
    if (m.ariaCount > 0) filesWithAria++;
    if (m.roleCount > 0) filesWithRoles++;
    totalAriaAttrs += m.ariaCount;
    totalRoleAttrs += m.roleCount;
    if (m.hasErrorHandling) filesWithErrorHandling++;
    if (m.hasLoadingState) filesWithLoadingStates++;
    if (m.hasEmptyState) filesWithEmptyStates++;
    if (m.mediaQueryCount > 0) filesWithMediaQueries++;
    if (m.responsiveClassCount > 0) filesWithResponsiveClasses++;
    if (m.hasNavigation) filesWithNavigation++;
    if (m.componentPrefix !== null) {
      prefixCounts[m.componentPrefix] = (prefixCounts[m.componentPrefix] ?? 0) + 1;
    }
  }

  // Determine dominant prefix
  let dominantPrefix: string | null = null;
  let maxPrefixCount = 0;
  let totalPrefixed = 0;
  for (const [prefix, count] of Object.entries(prefixCounts)) {
    totalPrefixed += count;
    if (count > maxPrefixCount) {
      maxPrefixCount = count;
      dominantPrefix = prefix;
    }
  }

  const prefixConsistency = totalPrefixed > 0 ? maxPrefixCount / totalPrefixed : 1;

  return {
    filesWithAria,
    filesWithRoles,
    totalAriaAttrs,
    totalRoleAttrs,
    filesWithErrorHandling,
    filesWithLoadingStates,
    filesWithEmptyStates,
    filesWithMediaQueries,
    filesWithResponsiveClasses,
    filesWithNavigation,
    accessibilityCoverage: filesWithAria / total,
    errorStateCoverage: filesWithErrorHandling / total,
    loadingStateCoverage: filesWithLoadingStates / total,
    responsiveCoverage: (filesWithMediaQueries + filesWithResponsiveClasses) / total,
    componentPrefixes: Object.fromEntries(Object.entries(prefixCounts).sort((a, b) => compare(a[0], b[0]))),
    dominantPrefix,
    prefixConsistency,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractFileName(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const fileName = parts[parts.length - 1] ?? "";
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
}

function buildConfidenceFactors(
  ariaCount: number,
  roleCount: number,
  hasErrorHandling: boolean,
  hasLoadingState: boolean,
  mediaQueryCount: number,
  responsiveClassCount: number,
  hasNavigation: boolean,
): { name: string; weight: number; score: number }[] {
  const factors: { name: string; weight: number; score: number }[] = [];
  if (ariaCount > 0 || roleCount > 0) {
    factors.push({ name: "accessibility", weight: 0.25, score: Math.min(ariaCount + roleCount, 5) / 5 });
  }
  if (hasErrorHandling || hasLoadingState) {
    factors.push({ name: "state-handling", weight: 0.25, score: (hasErrorHandling ? 0.5 : 0) + (hasLoadingState ? 0.5 : 0) });
  }
  if (mediaQueryCount > 0 || responsiveClassCount > 0) {
    factors.push({ name: "responsive", weight: 0.25, score: Math.min(mediaQueryCount + responsiveClassCount, 5) / 5 });
  }
  if (hasNavigation) {
    factors.push({ name: "navigation", weight: 0.25, score: 1.0 });
  }
  if (factors.length === 0) {
    factors.push({ name: "baseline", weight: 1, score: 0.3 });
  }
  return factors;
}

function computeOutputHash(
  patterns: readonly PatternResult[],
  diagnostics: readonly AnalyzerDiagnostic[],
): OutputHash {
  const payload = stableStringify({ patterns, diagnostics });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
