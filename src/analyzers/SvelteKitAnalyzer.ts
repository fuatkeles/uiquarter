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

const SVELTEKIT_EXTENSIONS = new Set(["ts", "js", "svelte"]);

/** Svelte 5 rune names. */
const SVELTE_RUNES = ["$state", "$derived", "$effect", "$props", "$bindable", "$inspect"] as const;

/** Route group pattern: (groupName) */
const ROUTE_GROUP_RE = /\(([^)]+)\)/;

/** Dynamic segment: [param] or [...rest] or [[optional]] */
const DYNAMIC_SEGMENT_RE = /\[{1,2}(?:\.{3})?([^\]]+)\]{1,2}/;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type SvelteKitFileRole =
  | "page"
  | "page-server"
  | "layout"
  | "layout-server"
  | "error"
  | "server-endpoint"
  | "hooks-server"
  | "hooks-client"
  | "param-matcher"
  | "config"
  | "component"
  | "regular";

interface SvelteKitFileInfo {
  readonly filePath: string;
  readonly role: SvelteKitFileRole;
  readonly routePath: string | null;
  readonly routeGroup: string | null;
  readonly dynamicSegments: readonly string[];
  readonly exportNames: readonly string[];
  readonly isDefaultExport: boolean;
  readonly runesUsed: readonly string[];
  readonly hasLoadFunction: boolean;
  readonly hasActions: boolean;
  readonly hasHandle: boolean;
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

function computeRoutePath(relativePath: string): string | null {
  const norm = normalizeToPosix(relativePath);

  let prefix: string;
  if (norm.startsWith("src/routes/")) prefix = "src/routes/";
  else if (norm.startsWith("routes/")) prefix = "routes/";
  else return null;

  const stripped = norm.slice(prefix.length);
  const dir = getFileDir(stripped);

  // Route is the directory path (stripping route groups)
  const routeParts = dir === ""
    ? []
    : dir.split("/").filter((p) => !ROUTE_GROUP_RE.test(p));

  const mapped = routeParts.map((p) => {
    const rest = /^\[\.\.\.([^\]]+)\]$/.exec(p);
    if (rest !== null) return `*${rest[1]}`;
    const optional = /^\[\[([^\]]+)\]\]$/.exec(p);
    if (optional !== null) return `:${optional[1]}?`;
    const dyn = /^\[([^\]]+)\]$/.exec(p);
    if (dyn !== null) return `:${dyn[1]}`;
    return p;
  });

  return "/" + mapped.join("/");
}

function detectRunes(content: string): string[] {
  const found: string[] = [];
  for (const rune of SVELTE_RUNES) {
    // Match $state( or $state.fine( etc.
    const re = new RegExp(`\\${rune}(?:\\.|\\()`, "g");
    if (re.test(content)) found.push(rune);
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// SvelteKitAnalyzer
// ---------------------------------------------------------------------------

export class SvelteKitAnalyzer implements Analyzer {
  readonly name = "sveltekit";
  readonly version = "1.0.0";
  readonly capabilities = [
    "sveltekit-route-detection",
    "sveltekit-layout-hierarchy",
    "sveltekit-load-function-detection",
    "sveltekit-server-endpoint-detection",
    "sveltekit-rune-detection",
    "sveltekit-form-action-detection",
    "sveltekit-hooks-detection",
  ] as const;
  readonly dependencies = ["component"] as const;

  private runDiagnostics: AnalyzerDiagnostic[] = [];

  fileFilter(file: DiscoveredFile): boolean {
    return SVELTEKIT_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const startedAt = Date.now();
    this.runDiagnostics = [];

    if (!this.isSvelteKitProject(context.files)) {
      return this.buildEmptyOutput(startedAt, context.files.length);
    }

    const sortedFiles = [...context.files].sort((a, b) =>
      compare(normalizeToPosix(a.relativePath), normalizeToPosix(b.relativePath)),
    );

    let cacheHits = 0;
    let cacheMisses = 0;
    const fileInfos: SvelteKitFileInfo[] = [];

    for (const file of sortedFiles) {
      if (context.signal?.aborted === true) break;

      if (!this.isSvelteKitRelevant(file)) continue;

      const key = `sveltekit:${file.relativePath}` as CacheKey;
      const cached = context.cache.get<SvelteKitFileInfo>(key);

      if (cached !== undefined && cached.inputHash === file.hash) {
        fileInfos.push(cached.value);
        cacheHits += 1;
        continue;
      }

      const info = await this.analyzeFile(file);
      context.cache.set(key, info, file.hash);
      fileInfos.push(info);
      cacheMisses += 1;
    }

    const patterns = this.buildPatterns(fileInfos);
    const diagnostics: AnalyzerDiagnostic[] = [...this.runDiagnostics];
    this.addDiagnostics(fileInfos, diagnostics);

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

    const allRunes = [...new Set(fileInfos.flatMap((f) => f.runesUsed))].sort();

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
        pageCount: fileInfos.filter((f) => f.role === "page").length,
        layoutCount: fileInfos.filter((f) => f.role === "layout").length,
        serverEndpointCount: fileInfos.filter((f) => f.role === "server-endpoint").length,
        loadFunctionCount: fileInfos.filter((f) => f.hasLoadFunction).length,
        formActionCount: fileInfos.filter((f) => f.hasActions).length,
        hooksDetected: fileInfos.some((f) => f.role === "hooks-server" || f.role === "hooks-client"),
        runesUsed: allRunes,
        routeGroups: [...new Set(fileInfos.flatMap((f) => f.routeGroup !== null ? [f.routeGroup] : []))].sort(),
        dynamicRouteCount: fileInfos.filter((f) => f.dynamicSegments.length > 0).length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Project detection
  // -------------------------------------------------------------------------

  private isSvelteKitProject(files: readonly DiscoveredFile[]): boolean {
    for (const file of files) {
      const norm = normalizeToPosix(file.relativePath);
      if (norm === "svelte.config.js" || norm === "svelte.config.ts") return true;
    }
    return false;
  }

  private isSvelteKitRelevant(file: DiscoveredFile): boolean {
    const norm = normalizeToPosix(file.relativePath);

    // Config files at root
    if (!norm.includes("/")) {
      const baseName = getBaseName(norm);
      if (baseName === "svelte.config") return true;
      if (baseName === "hooks.server" || baseName === "hooks.client") return true;
    }

    // src/ level hooks
    if (norm.startsWith("src/") && norm.split("/").length === 2) {
      const baseName = getBaseName(norm);
      if (baseName === "hooks.server" || baseName === "hooks.client") return true;
    }

    // Routes
    if (norm.startsWith("src/routes/") || norm.startsWith("routes/")) return true;

    // Params matchers
    if (norm.startsWith("src/params/") || norm.startsWith("params/")) return true;

    // Lib (components, utils)
    if (norm.startsWith("src/lib/") && file.extension === "svelte") return true;

    return false;
  }

  // -------------------------------------------------------------------------
  // File analysis
  // -------------------------------------------------------------------------

  private async analyzeFile(file: DiscoveredFile): Promise<SvelteKitFileInfo> {
    const norm = normalizeToPosix(file.relativePath);

    let content: string;
    try {
      content = await readFile(file.absolutePath, "utf-8");
    } catch {
      return this.makeRegularInfo(file);
    }

    const baseName = getBaseName(norm);
    const exportNames = this.extractExportNames(content);
    const isDefaultExport = this.hasDefaultExport(content);
    const runesUsed = file.extension === "svelte" ? detectRunes(content) : [];
    const hasLoadFunction = exportNames.includes("load") || /export\s+(async\s+)?function\s+load\b/.test(content);
    const hasActions = exportNames.includes("actions") || /export\s+const\s+actions\b/.test(content);
    const hasHandle = exportNames.includes("handle") || /export\s+(async\s+)?function\s+handle\b/.test(content);

    // Root/src level hooks
    if (baseName === "hooks.server" || baseName === "hooks.client") {
      const role: SvelteKitFileRole = baseName === "hooks.server" ? "hooks-server" : "hooks-client";
      return {
        filePath: norm,
        role,
        routePath: null,
        routeGroup: null,
        dynamicSegments: [],
        exportNames,
        isDefaultExport,
        runesUsed,
        hasLoadFunction,
        hasActions,
        hasHandle,
      };
    }

    // Config
    if (baseName === "svelte.config") {
      return {
        filePath: norm,
        role: "config",
        routePath: null,
        routeGroup: null,
        dynamicSegments: [],
        exportNames,
        isDefaultExport,
        runesUsed: [],
        hasLoadFunction: false,
        hasActions: false,
        hasHandle: false,
      };
    }

    // Param matchers
    if (norm.startsWith("src/params/") || norm.startsWith("params/")) {
      return {
        filePath: norm,
        role: "param-matcher",
        routePath: null,
        routeGroup: null,
        dynamicSegments: [],
        exportNames,
        isDefaultExport,
        runesUsed: [],
        hasLoadFunction: false,
        hasActions: false,
        hasHandle: false,
      };
    }

    // Lib components
    if ((norm.startsWith("src/lib/") && file.extension === "svelte")) {
      return {
        filePath: norm,
        role: "component",
        routePath: null,
        routeGroup: null,
        dynamicSegments: [],
        exportNames,
        isDefaultExport,
        runesUsed,
        hasLoadFunction: false,
        hasActions: false,
        hasHandle: false,
      };
    }

    // Route files
    const role = this.detectRouteFileRole(baseName, file.extension);
    const routePath = computeRoutePath(norm);
    const routeGroups = extractRouteGroups(norm);
    const dynamicSegments = extractDynamicSegments(norm);

    return {
      filePath: norm,
      role,
      routePath,
      routeGroup: routeGroups.length > 0 ? routeGroups[0]! : null,
      dynamicSegments,
      exportNames,
      isDefaultExport,
      runesUsed,
      hasLoadFunction,
      hasActions,
      hasHandle,
    };
  }

  private detectRouteFileRole(baseName: string, extension: string): SvelteKitFileRole {
    if (baseName === "+page" && extension === "svelte") return "page";
    if (baseName === "+page" || baseName === "+page.server") return "page-server";
    if (baseName === "+layout" && extension === "svelte") return "layout";
    if (baseName === "+layout" || baseName === "+layout.server") return "layout-server";
    if (baseName === "+error") return "error";
    if (baseName === "+server") return "server-endpoint";
    return "regular";
  }

  // -------------------------------------------------------------------------
  // Content helpers
  // -------------------------------------------------------------------------

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

  private buildPatterns(fileInfos: readonly SvelteKitFileInfo[]): PatternResult[] {
    const patterns: PatternResult[] = [];

    patterns.push(this.buildSummaryPattern(fileInfos));

    for (const info of fileInfos) {
      if (info.role === "regular" || info.role === "config") continue;
      patterns.push(this.buildFilePattern(info));
    }

    return patterns;
  }

  private buildSummaryPattern(fileInfos: readonly SvelteKitFileInfo[]): PatternResult {
    const pages = fileInfos.filter((f) => f.role === "page");
    const layouts = fileInfos.filter((f) => f.role === "layout");
    const serverEndpoints = fileInfos.filter((f) => f.role === "server-endpoint");
    const allRunes = [...new Set(fileInfos.flatMap((f) => f.runesUsed))].sort();

    return {
      id: `.:sveltekit-framework:1` as PatternId,
      type: "utility" as PatternType,
      name: "sveltekit-framework",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      confidence: {
        value: 1.0,
        source: "sveltekit-detection",
        factors: [{ name: "svelte-config", weight: 1.0, score: 1.0 }],
      },
      framework: "svelte",
      dependencies: [],
      properties: {},
      metadata: {
        pageCount: pages.length,
        layoutCount: layouts.length,
        serverEndpointCount: serverEndpoints.length,
        loadFunctionCount: fileInfos.filter((f) => f.hasLoadFunction).length,
        formActionCount: fileInfos.filter((f) => f.hasActions).length,
        hooksDetected: fileInfos.some((f) => f.role === "hooks-server" || f.role === "hooks-client"),
        runesUsed: allRunes,
        usesSvelte5Runes: allRunes.length > 0,
        routeGroups: [...new Set(fileInfos.flatMap((f) => f.routeGroup !== null ? [f.routeGroup] : []))].sort(),
        dynamicRouteCount: fileInfos.filter((f) => f.dynamicSegments.length > 0).length,
        routes: pages.map((f) => f.routePath).filter(Boolean).sort() as string[],
        serverEndpoints: serverEndpoints.map((f) => f.routePath).filter(Boolean).sort() as string[],
      },
    };
  }

  private buildFilePattern(info: SvelteKitFileInfo): PatternResult {
    const patternType = this.roleToPatternType(info.role);
    const name = this.buildPatternName(info);
    const confidence = this.buildConfidence(info);

    const metadata: Record<string, unknown> = {
      sveltekitRole: info.role,
    };

    if (info.routePath !== null) metadata["routePath"] = info.routePath;
    if (info.routeGroup !== null) metadata["routeGroup"] = info.routeGroup;
    if (info.dynamicSegments.length > 0) metadata["dynamicSegments"] = info.dynamicSegments;
    if (info.runesUsed.length > 0) metadata["runesUsed"] = info.runesUsed;
    if (info.hasLoadFunction) metadata["hasLoadFunction"] = true;
    if (info.hasActions) metadata["hasFormActions"] = true;
    if (info.hasHandle) metadata["hasHandle"] = true;
    if (info.exportNames.length > 0) metadata["exports"] = info.exportNames;

    return {
      id: `${info.filePath}:${name}:1` as PatternId,
      type: patternType,
      name,
      filePath: info.filePath,
      location: { file: info.filePath, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      confidence,
      framework: "svelte",
      dependencies: [],
      properties: {},
      metadata,
    };
  }

  private roleToPatternType(role: SvelteKitFileRole): PatternType {
    switch (role) {
      case "page": return "page";
      case "page-server": return "utility";
      case "layout": return "layout";
      case "layout-server": return "utility";
      case "error": return "component";
      case "server-endpoint": return "utility";
      case "hooks-server": return "utility";
      case "hooks-client": return "utility";
      case "param-matcher": return "utility";
      case "component": return "component";
      default: return "component";
    }
  }

  private buildPatternName(info: SvelteKitFileInfo): string {
    const baseName = getBaseName(info.filePath);
    const route = info.routePath ?? "/";

    switch (info.role) {
      case "page": return `Page:${route}`;
      case "page-server": return `PageServer:${route}`;
      case "layout": return `Layout:${route}`;
      case "layout-server": return `LayoutServer:${route}`;
      case "error": return `Error:${route}`;
      case "server-endpoint": return `Endpoint:${route}`;
      case "hooks-server": return "HooksServer";
      case "hooks-client": return "HooksClient";
      case "param-matcher": return `ParamMatcher:${baseName}`;
      case "component": return baseName.charAt(0).toUpperCase() + baseName.slice(1);
      default: return baseName;
    }
  }

  private buildConfidence(info: SvelteKitFileInfo): ConfidenceScore {
    const factors = [];
    let total = 0;

    // Special file naming (+page, +layout, etc.)
    const isSpecialFile = info.filePath.includes("+");
    if (isSpecialFile) {
      factors.push({ name: "special-file-prefix", weight: 0.5, score: 1.0 });
      total += 0.5;
    } else {
      factors.push({ name: "special-file-prefix", weight: 0.5, score: 0.3 });
      total += 0.15;
    }

    // Load function / actions presence
    if (info.hasLoadFunction || info.hasActions) {
      factors.push({ name: "sveltekit-api", weight: 0.3, score: 1.0 });
      total += 0.3;
    } else {
      factors.push({ name: "sveltekit-api", weight: 0.3, score: 0.3 });
      total += 0.09;
    }

    // Rune usage
    if (info.runesUsed.length > 0) {
      factors.push({ name: "svelte-runes", weight: 0.2, score: 1.0 });
      total += 0.2;
    } else {
      factors.push({ name: "svelte-runes", weight: 0.2, score: 0.5 });
      total += 0.1;
    }

    return {
      value: Math.min(1.0, total),
      source: "sveltekit-analysis",
      factors,
    };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  private addDiagnostics(
    fileInfos: readonly SvelteKitFileInfo[],
    diagnostics: AnalyzerDiagnostic[],
  ): void {
    // Warn about +page.svelte without load if sibling +page.server.ts exists
    const pageServerPaths = new Set(
      fileInfos
        .filter((f) => f.role === "page-server")
        .map((f) => getFileDir(f.filePath)),
    );

    for (const info of fileInfos) {
      if (info.role === "page") {
        const dir = getFileDir(info.filePath);
        if (pageServerPaths.has(dir)) {
          // This is fine — just informational
          diagnostics.push({
            severity: "info",
            filePath: info.filePath,
            message: "Page has a corresponding server load file (+page.server).",
            line: 1,
          });
        }
      }
    }

    // Warn about hooks without handle export
    for (const info of fileInfos) {
      if (info.role === "hooks-server" && !info.hasHandle) {
        diagnostics.push({
          severity: "warning",
          filePath: info.filePath,
          message: "hooks.server file does not export a handle function.",
          line: 1,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private makeRegularInfo(file: DiscoveredFile): SvelteKitFileInfo {
    return {
      filePath: normalizeToPosix(file.relativePath),
      role: "regular",
      routePath: null,
      routeGroup: null,
      dynamicSegments: [],
      exportNames: [],
      isDefaultExport: false,
      runesUsed: [],
      hasLoadFunction: false,
      hasActions: false,
      hasHandle: false,
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
