import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerId,
  AnalyzerOutput,
  CacheKey,
  ConfidenceScore,
  DiscoveredFile,
  PatternId,
  PatternResult,
  PatternType,
} from "../types/index.js";
import { compare } from "../core/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEXTJS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);

/** Next.js App Router special file names (without extension). */
const APP_ROUTER_SPECIAL_FILES = new Set([
  "layout",
  "page",
  "loading",
  "error",
  "not-found",
  "template",
  "default",
  "global-error",
  "route",
]);

/** Next.js special config-level files. */
const CONFIG_FILES = new Set([
  "middleware",
  "next.config",
  "instrumentation",
]);

/** Route group pattern: (groupName) */
const ROUTE_GROUP_RE = /\(([^)]+)\)/;

/** Dynamic segment pattern: [param] or [...param] or [[...param]] */
const DYNAMIC_SEGMENT_RE = /\[{1,2}(?:\.{3})?([^\]]+)\]{1,2}/;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type NextjsRouterKind = "app" | "pages" | "hybrid" | "unknown";

type NextjsFileRole =
  | "page"
  | "layout"
  | "loading"
  | "error"
  | "not-found"
  | "template"
  | "default"
  | "global-error"
  | "route-handler"
  | "middleware"
  | "api-route"
  | "server-component"
  | "client-component"
  | "config"
  | "instrumentation"
  | "regular";

interface NextjsFileInfo {
  readonly filePath: string;
  readonly role: NextjsFileRole;
  readonly routerKind: "app" | "pages" | "root";
  readonly routePath: string | null;
  readonly routeGroup: string | null;
  readonly dynamicSegments: readonly string[];
  readonly hasUseClient: boolean;
  readonly hasUseServer: boolean;
  readonly exportNames: readonly string[];
  readonly isDefaultExport: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeToPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function getBaseName(relativePath: string): string {
  const parts = normalizeToPosix(relativePath).split("/");
  const last = parts[parts.length - 1] ?? "";
  const dotIndex = last.lastIndexOf(".");
  return dotIndex > 0 ? last.slice(0, dotIndex) : last;
}

function getFileDir(relativePath: string): string {
  const norm = normalizeToPosix(relativePath);
  const lastSlash = norm.lastIndexOf("/");
  return lastSlash >= 0 ? norm.slice(0, lastSlash) : "";
}

function extractRouteGroups(relativePath: string): string[] {
  const parts = normalizeToPosix(relativePath).split("/");
  const groups: string[] = [];
  for (const part of parts) {
    const match = ROUTE_GROUP_RE.exec(part);
    if (match !== null) groups.push(match[1]!);
  }
  return groups;
}

function extractDynamicSegments(relativePath: string): string[] {
  const parts = normalizeToPosix(relativePath).split("/");
  const segments: string[] = [];
  for (const part of parts) {
    const match = DYNAMIC_SEGMENT_RE.exec(part);
    if (match !== null) segments.push(match[1]!);
  }
  return segments;
}

function computeRoutePath(relativePath: string, routerKind: "app" | "pages"): string | null {
  const norm = normalizeToPosix(relativePath);
  let prefix: string;

  if (routerKind === "app") {
    // Strip "app/" or "src/app/" prefix
    if (norm.startsWith("src/app/")) prefix = "src/app/";
    else if (norm.startsWith("app/")) prefix = "app/";
    else return null;
  } else {
    // Strip "pages/" or "src/pages/" prefix
    if (norm.startsWith("src/pages/")) prefix = "src/pages/";
    else if (norm.startsWith("pages/")) prefix = "pages/";
    else return null;
  }

  const stripped = norm.slice(prefix.length);
  const dir = getFileDir(stripped);
  const baseName = getBaseName(stripped);

  // Build the URL path
  let routeParts: string[];
  if (dir === "") {
    routeParts = [];
  } else {
    routeParts = dir.split("/").filter((p) => !ROUTE_GROUP_RE.test(p));
  }

  // For App Router, the baseName is a special file (page, route, layout, etc.)
  // so the route is just the directory path.
  // For Pages Router, the baseName IS the route unless it's "index".
  if (routerKind === "pages" && baseName !== "index") {
    routeParts.push(baseName);
  }

  // Convert dynamic segments to : notation
  const mapped = routeParts.map((p) => {
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(p);
    if (catchAll !== null) return `*${catchAll[1]}`;
    const optCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(p);
    if (optCatchAll !== null) return `*${optCatchAll[1]}?`;
    const dyn = /^\[([^\]]+)\]$/.exec(p);
    if (dyn !== null) return `:${dyn[1]}`;
    return p;
  });

  return "/" + mapped.join("/");
}

// ---------------------------------------------------------------------------
// NextjsAnalyzer
// ---------------------------------------------------------------------------

export class NextjsAnalyzer implements Analyzer {
  readonly name = "nextjs";
  readonly version = "1.0.0";
  readonly capabilities = [
    "nextjs-router-detection",
    "server-client-classification",
    "layout-hierarchy",
    "route-group-detection",
    "middleware-detection",
    "api-route-detection",
    "dynamic-route-detection",
  ] as const;
  readonly dependencies = ["component"] as const;

  private runDiagnostics: AnalyzerDiagnostic[] = [];

  fileFilter(file: DiscoveredFile): boolean {
    return NEXTJS_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const startedAt = Date.now();
    this.runDiagnostics = [];

    // Determine router kind from file paths
    const routerKind = this.detectRouterKind(context.files);

    if (routerKind === "unknown") {
      // Not a Next.js project — return empty
      return this.buildEmptyOutput(startedAt, context.files.length);
    }

    const sortedFiles = [...context.files].sort((a, b) =>
      compare(normalizeToPosix(a.relativePath), normalizeToPosix(b.relativePath)),
    );

    let cacheHits = 0;
    let cacheMisses = 0;
    const fileInfos: NextjsFileInfo[] = [];

    for (const file of sortedFiles) {
      if (context.signal?.aborted === true) break;

      // Only analyze files in app/, pages/, or root config files
      if (!this.isNextjsRelevant(file, routerKind)) continue;

      const key = `nextjs:${file.relativePath}` as CacheKey;
      const cached = context.cache.get<NextjsFileInfo>(key);

      if (cached !== undefined && cached.inputHash === file.hash) {
        fileInfos.push(cached.value);
        cacheHits += 1;
        continue;
      }

      const info = await this.analyzeFile(file, context.rootPath, routerKind);
      context.cache.set(key, info, file.hash);
      fileInfos.push(info);
      cacheMisses += 1;
    }

    // Build patterns from file info
    const patterns = this.buildPatterns(fileInfos, routerKind);
    const diagnostics: AnalyzerDiagnostic[] = [...this.runDiagnostics];

    // Add diagnostics for common issues
    this.addDiagnostics(fileInfos, routerKind, diagnostics);

    patterns.sort((a, b) =>
      compare(a.id as string, b.id as string) ||
      compare(a.filePath, b.filePath) ||
      compare(a.name, b.name),
    );

    diagnostics.sort((a, b) =>
      compare(a.filePath, b.filePath) ||
      compare(a.message, b.message),
    );

    const hashPayload = JSON.stringify({
      patterns: patterns.map((p) => ({
        id: p.id,
        type: p.type,
        name: p.name,
        filePath: p.filePath,
        confidence: p.confidence,
        dependencies: p.dependencies,
        properties: p.properties,
        metadata: p.metadata,
      })),
      diagnostics,
    });

    const hash = createHash("sha256").update(hashPayload).digest("hex");

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash: hash as import("../types/index.js").OutputHash,
      duration: Date.now() - startedAt,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: cacheHits + cacheMisses,
        cacheHits,
        cacheMisses,
      },
      metadata: {
        routerKind,
        appRouterFiles: fileInfos.filter((f) => f.routerKind === "app").length,
        pagesRouterFiles: fileInfos.filter((f) => f.routerKind === "pages").length,
        serverComponents: fileInfos.filter((f) => f.role === "server-component" || (!f.hasUseClient && f.routerKind === "app")).length,
        clientComponents: fileInfos.filter((f) => f.hasUseClient).length,
        middlewareDetected: fileInfos.some((f) => f.role === "middleware"),
        routeGroups: [...new Set(fileInfos.flatMap((f) => f.routeGroup !== null ? [f.routeGroup] : []))].sort(),
        dynamicRoutes: fileInfos.filter((f) => f.dynamicSegments.length > 0).length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Router detection
  // -------------------------------------------------------------------------

  private detectRouterKind(files: readonly DiscoveredFile[]): NextjsRouterKind {
    let hasAppDir = false;
    let hasPagesDir = false;
    let hasNextConfig = false;

    for (const file of files) {
      const norm = normalizeToPosix(file.relativePath);
      if (norm.startsWith("app/") || norm.startsWith("src/app/")) hasAppDir = true;
      if (norm.startsWith("pages/") || norm.startsWith("src/pages/")) hasPagesDir = true;
      if (norm === "next.config.js" || norm === "next.config.ts" || norm === "next.config.mjs") {
        hasNextConfig = true;
      }
    }

    // Require next.config or at least one Next.js special file
    if (!hasNextConfig && !hasAppDir && !hasPagesDir) return "unknown";

    if (hasAppDir && hasPagesDir) return "hybrid";
    if (hasAppDir) return "app";
    if (hasPagesDir) return "pages";

    // Has next.config but no app/ or pages/ — could be Next.js project in early setup
    return hasNextConfig ? "app" : "unknown";
  }

  private isNextjsRelevant(file: DiscoveredFile, routerKind: NextjsRouterKind): boolean {
    const norm = normalizeToPosix(file.relativePath);

    // Root-level config files
    const baseName = getBaseName(norm);
    if (CONFIG_FILES.has(baseName) && !norm.includes("/")) return true;

    // App Router files
    if (routerKind === "app" || routerKind === "hybrid") {
      if (norm.startsWith("app/") || norm.startsWith("src/app/")) return true;
    }

    // Pages Router files
    if (routerKind === "pages" || routerKind === "hybrid") {
      if (norm.startsWith("pages/") || norm.startsWith("src/pages/")) return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // File analysis
  // -------------------------------------------------------------------------

  private async analyzeFile(
    file: DiscoveredFile,
    _rootPath: string,
    projectRouterKind: NextjsRouterKind,
  ): Promise<NextjsFileInfo> {
    const norm = normalizeToPosix(file.relativePath);
    const baseName = getBaseName(norm);

    let content: string;
    try {
      content = await readFile(file.absolutePath, "utf-8");
    } catch {
      return this.makeRegularInfo(file, "root");
    }

    // Root-level files
    if (!norm.includes("/") || (norm.split("/").length === 2 && norm.startsWith("src/"))) {
      if (baseName === "middleware") {
        return {
          filePath: norm,
          role: "middleware",
          routerKind: "root",
          routePath: null,
          routeGroup: null,
          dynamicSegments: [],
          hasUseClient: this.hasDirective(content, "use client"),
          hasUseServer: this.hasDirective(content, "use server"),
          exportNames: this.extractExportNames(content),
          isDefaultExport: this.hasDefaultExport(content),
        };
      }

      if (baseName === "next.config" || baseName === "instrumentation") {
        return {
          filePath: norm,
          role: baseName === "next.config" ? "config" : "instrumentation",
          routerKind: "root",
          routePath: null,
          routeGroup: null,
          dynamicSegments: [],
          hasUseClient: false,
          hasUseServer: false,
          exportNames: this.extractExportNames(content),
          isDefaultExport: this.hasDefaultExport(content),
        };
      }
    }

    // Determine router kind for this file
    const fileRouterKind = this.detectFileRouterKind(norm, projectRouterKind);
    if (fileRouterKind === null) return this.makeRegularInfo(file, "root");

    const hasUseClient = this.hasDirective(content, "use client");
    const hasUseServer = this.hasDirective(content, "use server");
    const exportNames = this.extractExportNames(content);
    const isDefaultExport = this.hasDefaultExport(content);
    const routeGroups = extractRouteGroups(norm);
    const dynamicSegments = extractDynamicSegments(norm);

    // Detect role
    const role = this.detectFileRole(baseName, norm, fileRouterKind, hasUseClient, hasUseServer);
    const routePath = computeRoutePath(norm, fileRouterKind);

    return {
      filePath: norm,
      role,
      routerKind: fileRouterKind,
      routePath,
      routeGroup: routeGroups.length > 0 ? routeGroups[0]! : null,
      dynamicSegments,
      hasUseClient,
      hasUseServer,
      exportNames,
      isDefaultExport,
    };
  }

  private detectFileRouterKind(
    norm: string,
    _projectRouterKind: NextjsRouterKind,
  ): "app" | "pages" | null {
    if (norm.startsWith("app/") || norm.startsWith("src/app/")) return "app";
    if (norm.startsWith("pages/") || norm.startsWith("src/pages/")) return "pages";
    return null;
  }

  private detectFileRole(
    baseName: string,
    norm: string,
    routerKind: "app" | "pages",
    hasUseClient: boolean,
    _hasUseServer: boolean,
  ): NextjsFileRole {
    if (routerKind === "app") {
      if (baseName === "route") return "route-handler";
      if (baseName === "page") return "page";
      if (baseName === "layout") return "layout";
      if (baseName === "loading") return "loading";
      if (baseName === "error") return "error";
      if (baseName === "not-found") return "not-found";
      if (baseName === "template") return "template";
      if (baseName === "default") return "default";
      if (baseName === "global-error") return "global-error";

      // Non-special files in app dir
      if (hasUseClient) return "client-component";
      return "server-component";
    }

    // Pages Router
    if (this.isInPagesApiDir(norm)) return "api-route";
    return "page";
  }

  private isInPagesApiDir(norm: string): boolean {
    if (norm.startsWith("pages/api/") || norm.startsWith("src/pages/api/")) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Content parsing helpers (regex-based, no ts-morph needed)
  // -------------------------------------------------------------------------

  private hasDirective(content: string, directive: string): boolean {
    // "use client" or 'use client' at the top of the file
    const trimmed = content.trimStart();
    const first200 = trimmed.slice(0, 200);
    return (
      first200.includes(`"${directive}"`) ||
      first200.includes(`'${directive}'`)
    );
  }

  private extractExportNames(content: string): readonly string[] {
    const names: string[] = [];
    const namedExportRe = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = namedExportRe.exec(content)) !== null) {
      names.push(match[1]!);
    }
    return names.sort();
  }

  private hasDefaultExport(content: string): boolean {
    return /export\s+default\b/.test(content);
  }

  // -------------------------------------------------------------------------
  // Pattern building
  // -------------------------------------------------------------------------

  private buildPatterns(
    fileInfos: readonly NextjsFileInfo[],
    routerKind: NextjsRouterKind,
  ): PatternResult[] {
    const patterns: PatternResult[] = [];

    // Emit a project-level pattern summarizing the routing setup
    patterns.push(this.buildRouterPattern(fileInfos, routerKind));

    // Emit per-file patterns for special files
    for (const info of fileInfos) {
      if (info.role === "regular" || info.role === "config") continue;
      patterns.push(this.buildFilePattern(info));
    }

    return patterns;
  }

  private buildRouterPattern(
    fileInfos: readonly NextjsFileInfo[],
    routerKind: NextjsRouterKind,
  ): PatternResult {
    const appPages = fileInfos.filter((f) => f.routerKind === "app" && f.role === "page");
    const pagesPages = fileInfos.filter((f) => f.routerKind === "pages" && f.role === "page");
    const layouts = fileInfos.filter((f) => f.role === "layout");
    const routeHandlers = fileInfos.filter((f) => f.role === "route-handler");
    const apiRoutes = fileInfos.filter((f) => f.role === "api-route");
    const middleware = fileInfos.filter((f) => f.role === "middleware");
    const clientComponents = fileInfos.filter((f) => f.hasUseClient);
    const serverComponents = fileInfos.filter(
      (f) => f.routerKind === "app" && !f.hasUseClient && f.role !== "route-handler" && f.role !== "config",
    );
    const routeGroups = [...new Set(
      fileInfos.flatMap((f) => f.routeGroup !== null ? [f.routeGroup] : []),
    )].sort();
    const dynamicRoutes = fileInfos.filter((f) => f.dynamicSegments.length > 0);

    return {
      id: `.:nextjs-router:1` as PatternId,
      type: "utility" as PatternType,
      name: "nextjs-router",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      confidence: {
        value: 1.0,
        source: "nextjs-detection",
        factors: [{ name: "router-structure", weight: 1.0, score: 1.0 }],
      },
      framework: "react",
      dependencies: [],
      properties: {},
      metadata: {
        routerKind,
        appRouterPageCount: appPages.length,
        pagesRouterPageCount: pagesPages.length,
        layoutCount: layouts.length,
        routeHandlerCount: routeHandlers.length,
        apiRouteCount: apiRoutes.length,
        middlewareDetected: middleware.length > 0,
        clientComponentCount: clientComponents.length,
        serverComponentCount: serverComponents.length,
        routeGroups,
        dynamicRouteCount: dynamicRoutes.length,
        routes: [
          ...appPages.map((f) => f.routePath).filter(Boolean),
          ...pagesPages.map((f) => f.routePath).filter(Boolean),
        ].sort(),
      },
    };
  }

  private buildFilePattern(info: NextjsFileInfo): PatternResult {
    const patternType = this.roleToPatternType(info.role);
    const name = this.buildPatternName(info);
    const confidence = this.buildConfidence(info);

    const metadata: Record<string, unknown> = {
      nextjsRole: info.role,
      routerKind: info.routerKind,
    };

    if (info.routePath !== null) metadata["routePath"] = info.routePath;
    if (info.routeGroup !== null) metadata["routeGroup"] = info.routeGroup;
    if (info.dynamicSegments.length > 0) metadata["dynamicSegments"] = info.dynamicSegments;
    if (info.hasUseClient) metadata["isClientComponent"] = true;
    if (info.hasUseServer) metadata["isServerAction"] = true;
    if (info.exportNames.length > 0) metadata["exports"] = info.exportNames;

    return {
      id: `${info.filePath}:${name}:1` as PatternId,
      type: patternType,
      name,
      filePath: info.filePath,
      location: { file: info.filePath, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      confidence,
      framework: "react",
      dependencies: [],
      properties: {},
      metadata,
    };
  }

  private roleToPatternType(role: NextjsFileRole): PatternType {
    switch (role) {
      case "page": return "page";
      case "layout": return "layout";
      case "template": return "layout";
      case "loading": return "component";
      case "error": return "component";
      case "not-found": return "component";
      case "global-error": return "component";
      case "default": return "page";
      case "route-handler": return "utility";
      case "api-route": return "utility";
      case "middleware": return "utility";
      case "server-component": return "component";
      case "client-component": return "component";
      case "instrumentation": return "utility";
      default: return "component";
    }
  }

  private buildPatternName(info: NextjsFileInfo): string {
    const baseName = getBaseName(info.filePath);
    const dir = getFileDir(info.filePath);

    switch (info.role) {
      case "middleware":
        return "Middleware";
      case "config":
        return "NextConfig";
      case "instrumentation":
        return "Instrumentation";
      case "route-handler": {
        const route = info.routePath ?? dir;
        return `RouteHandler:${route}`;
      }
      case "api-route": {
        const route = info.routePath ?? dir;
        return `ApiRoute:${route}`;
      }
      case "page": {
        const route = info.routePath ?? "/";
        return `Page:${route}`;
      }
      case "layout": {
        const route = info.routePath ?? "/";
        return `Layout:${route}`;
      }
      default:
        return baseName.charAt(0).toUpperCase() + baseName.slice(1);
    }
  }

  private buildConfidence(info: NextjsFileInfo): ConfidenceScore {
    const factors = [];
    let total = 0;

    // Special file naming is a strong signal
    if (APP_ROUTER_SPECIAL_FILES.has(getBaseName(info.filePath))) {
      factors.push({ name: "special-file-name", weight: 0.5, score: 1.0 });
      total += 0.5;
    } else {
      factors.push({ name: "special-file-name", weight: 0.5, score: 0.3 });
      total += 0.15;
    }

    // Directives are a strong signal
    if (info.hasUseClient || info.hasUseServer) {
      factors.push({ name: "directive", weight: 0.3, score: 1.0 });
      total += 0.3;
    } else {
      factors.push({ name: "directive", weight: 0.3, score: 0.5 });
      total += 0.15;
    }

    // Default export is expected for pages/layouts
    if (info.isDefaultExport) {
      factors.push({ name: "default-export", weight: 0.2, score: 1.0 });
      total += 0.2;
    } else {
      factors.push({ name: "default-export", weight: 0.2, score: 0.4 });
      total += 0.08;
    }

    return {
      value: Math.min(1.0, total),
      source: "nextjs-analysis",
      factors,
    };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  private addDiagnostics(
    fileInfos: readonly NextjsFileInfo[],
    routerKind: NextjsRouterKind,
    diagnostics: AnalyzerDiagnostic[],
  ): void {
    // Warn about pages without default export
    for (const info of fileInfos) {
      if ((info.role === "page" || info.role === "layout") && !info.isDefaultExport) {
        diagnostics.push({
          severity: "warning",
          filePath: info.filePath,
          message: `${info.role} file does not have a default export — Next.js requires one.`,
          line: 1,
        });
      }
    }

    // Warn about "use client" in layout files (common mistake)
    for (const info of fileInfos) {
      if (info.role === "layout" && info.hasUseClient) {
        diagnostics.push({
          severity: "info",
          filePath: info.filePath,
          message: `Layout uses "use client" — this makes all children client components. Consider extracting client logic to a separate component.`,
          line: 1,
        });
      }
    }

    // Check for hybrid router usage
    if (routerKind === "hybrid") {
      diagnostics.push({
        severity: "info",
        filePath: ".",
        message: "Project uses both App Router and Pages Router. Consider migrating to App Router for consistency.",
      });
    }

    // Warn about "use server" at file level (Server Actions)
    for (const info of fileInfos) {
      if (info.hasUseServer && info.role === "page") {
        diagnostics.push({
          severity: "info",
          filePath: info.filePath,
          message: `Page uses "use server" directive — this marks all exports as Server Actions.`,
          line: 1,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private makeRegularInfo(file: DiscoveredFile, routerKind: "root"): NextjsFileInfo {
    return {
      filePath: normalizeToPosix(file.relativePath),
      role: "regular",
      routerKind,
      routePath: null,
      routeGroup: null,
      dynamicSegments: [],
      hasUseClient: false,
      hasUseServer: false,
      exportNames: [],
      isDefaultExport: false,
    };
  }

  private buildEmptyOutput(startedAt: number, totalFiles: number): AnalyzerOutput {
    const hashPayload = JSON.stringify({ patterns: [], diagnostics: [] });
    const hash = createHash("sha256").update(hashPayload).digest("hex");

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns: [],
      diagnostics: [],
      hash: hash as import("../types/index.js").OutputHash,
      duration: Date.now() - startedAt,
      stats: {
        totalFiles,
        analyzedFiles: 0,
        cacheHits: 0,
        cacheMisses: 0,
      },
    };
  }
}
