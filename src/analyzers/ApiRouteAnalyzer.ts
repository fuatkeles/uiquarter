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

const API_EXTENSIONS = new Set(["ts", "js", "mjs"]);

/** Framework import detection */
const EXPRESS_IMPORT_RE = /(?:from\s+['"]express['"]|require\s*\(\s*['"]express['"]\s*\))/;
const FASTIFY_IMPORT_RE = /(?:from\s+['"]fastify['"]|require\s*\(\s*['"]fastify['"]\s*\))/;
const NESTJS_IMPORT_RE = /from\s+['"]@nestjs\/(?:common|core|microservices)['"]/;
const HONO_IMPORT_RE = /(?:from\s+['"]hono['"]|require\s*\(\s*['"]hono['"]\s*\))/;
const TRPC_IMPORT_RE = /from\s+['"]@trpc\/server['"]/;
const GRAPHQL_IMPORT_RE = /from\s+['"]@nestjs\/graphql['"]/;

/** Express/Hono route handlers */
const EXPRESS_ROUTE_RE = /(?:app|router)\.(get|post|put|delete|patch|use|all|options|head)\s*\(\s*['"]([^'"]*)['"]/g;

/** Fastify route handlers */
const FASTIFY_ROUTE_RE = /(?:fastify|server|app)\.(get|post|put|delete|patch|all|options|head)\s*\(\s*['"]([^'"]*)['"]/g;
const FASTIFY_REGISTER_RE = /(?:fastify|server|app)\.register\s*\(/g;

/** NestJS decorators */
const CONTROLLER_RE = /@Controller\s*\(\s*['"]?([^'")]*)?['"]?\s*\)/g;
const NEST_METHOD_RE = /@(Get|Post|Put|Delete|Patch|All|Options|Head)\s*\(\s*['"]?([^'")]*)?['"]?\s*\)/g;

/** Hono route handlers */
const HONO_ROUTE_RE = /app\.(get|post|put|delete|patch|use|all)\s*\(\s*['"]([^'"]*)['"]/g;

/** tRPC patterns */
const TRPC_ROUTER_RE = /(?:t\.router|router)\s*\(\s*\{/g;
const TRPC_PROCEDURE_RE = /(publicProcedure|protectedProcedure)\b/g;

/** GraphQL NestJS */
const RESOLVER_RE = /@Resolver\s*\(/g;
const QUERY_RE = /@Query\s*\(/g;
const MUTATION_RE = /@Mutation\s*\(/g;

/** Middleware patterns */
const MIDDLEWARE_FN_RE = /(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:function\s*)?\()\s*\(?\s*(?:req|request)\s*,\s*(?:res|response)\s*,\s*(?:next)\s*\)?/g;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

type ApiFramework = "express" | "fastify" | "nestjs" | "hono" | "trpc" | "graphql" | "unknown";

interface ApiEndpoint {
  readonly method: string;
  readonly path: string;
}

interface ApiFileMetrics {
  readonly filePath: string;
  readonly framework: ApiFramework;
  readonly endpoints: readonly ApiEndpoint[];
  readonly middlewareCount: number;
  readonly controllerPaths: readonly string[];
  readonly trpcRouterCount: number;
  readonly trpcProcedureCount: number;
  readonly resolverCount: number;
  readonly queryCount: number;
  readonly mutationCount: number;
  readonly hasRegister: boolean;
}

// -----------------------------------------------------------------------------
// ApiRouteAnalyzer
// -----------------------------------------------------------------------------

export class ApiRouteAnalyzer implements Analyzer {
  readonly name = "api-routes";
  readonly version = "1.0.0";
  readonly capabilities = [
    "express-detection",
    "fastify-detection",
    "nestjs-detection",
    "hono-detection",
    "trpc-detection",
    "graphql-detection",
    "middleware-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return API_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: ApiFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `api-routes:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<ApiFileMetrics>(cacheKey);
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

      const metrics = analyzeApiFile(file, content);
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Only produce patterns if at least one framework detected
    const detectedFiles = allMetrics.filter((m) => m.framework !== "unknown");
    if (detectedFiles.length === 0) {
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
    let totalEndpoints = 0;
    const methodCounts: Record<string, number> = {};
    let totalMiddleware = 0;
    let totalResolvers = 0;
    let totalQueries = 0;
    let totalMutations = 0;
    let totalTrpcProcedures = 0;
    const detectedFrameworks = new Set<string>();

    for (const m of detectedFiles) {
      detectedFrameworks.add(m.framework);
      totalEndpoints += m.endpoints.length;
      totalMiddleware += m.middlewareCount;
      totalResolvers += m.resolverCount;
      totalQueries += m.queryCount;
      totalMutations += m.mutationCount;
      totalTrpcProcedures += m.trpcProcedureCount;

      for (const ep of m.endpoints) {
        const method = ep.method.toUpperCase();
        methodCounts[method] = (methodCounts[method] ?? 0) + 1;
      }

      // Emit per-file endpoint patterns
      for (const ep of m.endpoints) {
        const pid = `${m.filePath}:endpoint:${ep.method}:${ep.path}` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `${ep.method.toUpperCase()} ${ep.path}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "route-detection",
            factors: [{ name: "api-route-match", weight: 1, score: 0.9 }],
          },
          framework: m.framework,
          dependencies: [],
          properties: {},
          metadata: { method: ep.method, path: ep.path },
        });
      }

      // Middleware patterns
      if (m.middlewareCount > 0) {
        const pid = `${m.filePath}:middleware:1` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `middleware:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.8,
            source: "middleware-detection",
            factors: [{ name: "middleware-pattern", weight: 1, score: 0.8 }],
          },
          framework: m.framework,
          dependencies: [],
          properties: {},
          metadata: { middlewareCount: m.middlewareCount },
        });
      }

      // Controller patterns (NestJS)
      for (const cp of m.controllerPaths) {
        const pid = `${m.filePath}:controller:${cp}` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `controller:${cp || "/"}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.95,
            source: "decorator-detection",
            factors: [{ name: "nestjs-controller", weight: 1, score: 0.95 }],
          },
          framework: "nestjs",
          dependencies: [],
          properties: {},
          metadata: { controllerPath: cp },
        });
      }

      // GraphQL resolvers
      if (m.resolverCount > 0) {
        const pid = `${m.filePath}:resolver:1` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `resolver:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "graphql-detection",
            factors: [{ name: "graphql-resolver", weight: 1, score: 0.9 }],
          },
          framework: "graphql",
          dependencies: [],
          properties: {},
          metadata: {
            resolverCount: m.resolverCount,
            queryCount: m.queryCount,
            mutationCount: m.mutationCount,
          },
        });
      }
    }

    // Summary
    const sortedMethods = Object.fromEntries(
      Object.entries(methodCounts).sort((a, b) => compare(a[0], b[0])),
    );
    const summaryId = `.:api-routes-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "api-routes-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.9,
        source: "api-analysis",
        factors: [{ name: "framework-detection", weight: 1, score: 0.9 }],
      },
      framework: "generic",
      dependencies: [],
      properties: {},
      metadata: {
        totalEndpoints,
        methods: sortedMethods,
        totalMiddleware,
        totalResolvers,
        totalQueries,
        totalMutations,
        totalTrpcProcedures,
        detectedFrameworks: [...detectedFrameworks].sort(),
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

function analyzeApiFile(file: DiscoveredFile, content: string): ApiFileMetrics {
  // Detect framework
  let framework: ApiFramework = "unknown";
  if (NESTJS_IMPORT_RE.test(content) || GRAPHQL_IMPORT_RE.test(content)) {
    framework = "nestjs";
  } else if (TRPC_IMPORT_RE.test(content)) {
    framework = "trpc";
  } else if (HONO_IMPORT_RE.test(content)) {
    framework = "hono";
  } else if (FASTIFY_IMPORT_RE.test(content)) {
    framework = "fastify";
  } else if (EXPRESS_IMPORT_RE.test(content)) {
    framework = "express";
  }

  if (framework === "unknown") {
    return {
      filePath: file.relativePath,
      framework,
      endpoints: [],
      middlewareCount: 0,
      controllerPaths: [],
      trpcRouterCount: 0,
      trpcProcedureCount: 0,
      resolverCount: 0,
      queryCount: 0,
      mutationCount: 0,
      hasRegister: false,
    };
  }

  const endpoints: ApiEndpoint[] = [];
  let match: RegExpExecArray | null;

  // Express routes
  if (framework === "express") {
    const re = new RegExp(EXPRESS_ROUTE_RE.source, EXPRESS_ROUTE_RE.flags);
    while ((match = re.exec(content)) !== null) {
      endpoints.push({ method: match[1]!, path: match[2]! });
    }
  }

  // Fastify routes
  if (framework === "fastify") {
    const re = new RegExp(FASTIFY_ROUTE_RE.source, FASTIFY_ROUTE_RE.flags);
    while ((match = re.exec(content)) !== null) {
      endpoints.push({ method: match[1]!, path: match[2]! });
    }
  }

  // Hono routes
  if (framework === "hono") {
    const re = new RegExp(HONO_ROUTE_RE.source, HONO_ROUTE_RE.flags);
    while ((match = re.exec(content)) !== null) {
      endpoints.push({ method: match[1]!, path: match[2]! });
    }
  }

  // NestJS controller + method decorators
  const controllerPaths: string[] = [];
  if (framework === "nestjs") {
    const cRe = new RegExp(CONTROLLER_RE.source, CONTROLLER_RE.flags);
    while ((match = cRe.exec(content)) !== null) {
      controllerPaths.push(match[1] ?? "");
    }
    const mRe = new RegExp(NEST_METHOD_RE.source, NEST_METHOD_RE.flags);
    while ((match = mRe.exec(content)) !== null) {
      const basePath = controllerPaths.length > 0 ? controllerPaths[0]! : "";
      const subPath = match[2] ?? "";
      const fullPath = basePath ? `/${basePath}/${subPath}`.replace(/\/+/g, "/") : `/${subPath}`;
      endpoints.push({ method: match[1]!.toLowerCase(), path: fullPath });
    }
  }

  // tRPC
  const trpcRouterRe = new RegExp(TRPC_ROUTER_RE.source, TRPC_ROUTER_RE.flags);
  let trpcRouterCount = 0;
  while (trpcRouterRe.exec(content) !== null) trpcRouterCount++;

  const trpcProcRe = new RegExp(TRPC_PROCEDURE_RE.source, TRPC_PROCEDURE_RE.flags);
  let trpcProcedureCount = 0;
  while (trpcProcRe.exec(content) !== null) trpcProcedureCount++;

  // GraphQL
  const resolverRe = new RegExp(RESOLVER_RE.source, RESOLVER_RE.flags);
  let resolverCount = 0;
  while (resolverRe.exec(content) !== null) resolverCount++;

  const queryRe = new RegExp(QUERY_RE.source, QUERY_RE.flags);
  let queryCount = 0;
  while (queryRe.exec(content) !== null) queryCount++;

  const mutationRe = new RegExp(MUTATION_RE.source, MUTATION_RE.flags);
  let mutationCount = 0;
  while (mutationRe.exec(content) !== null) mutationCount++;

  // If GraphQL patterns found, upgrade framework
  if (resolverCount > 0 && framework === "nestjs") {
    framework = "graphql";
  }

  // Middleware
  const mwRe = new RegExp(MIDDLEWARE_FN_RE.source, MIDDLEWARE_FN_RE.flags);
  let middlewareCount = 0;
  while (mwRe.exec(content) !== null) middlewareCount++;

  // Fastify register
  const regRe = new RegExp(FASTIFY_REGISTER_RE.source, FASTIFY_REGISTER_RE.flags);
  let hasRegister = false;
  if (regRe.exec(content) !== null) hasRegister = true;

  return {
    filePath: file.relativePath,
    framework,
    endpoints,
    middlewareCount,
    controllerPaths,
    trpcRouterCount,
    trpcProcedureCount,
    resolverCount,
    queryCount,
    mutationCount,
    hasRegister,
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

function computeOutputHash(
  patterns: readonly PatternResult[],
  diagnostics: readonly AnalyzerDiagnostic[],
): OutputHash {
  const payload = stableStringify({ patterns, diagnostics });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
