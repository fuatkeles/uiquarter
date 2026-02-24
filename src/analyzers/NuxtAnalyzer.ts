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

const NUXT_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "vue"]);

/** Nuxt auto-import directories. */
const AUTO_IMPORT_DIRS = new Set(["composables", "utils"]);

/** Nuxt special directories. */
const NUXT_DIRS = new Set([
  "pages",
  "layouts",
  "middleware",
  "plugins",
  "composables",
  "server",
  "utils",
  "components",
  "assets",
  "public",
]);

/** Dynamic route segment: [param] or [...param] or [[param]] */
const DYNAMIC_SEGMENT_RE = /\[{1,2}(?:\.{3})?([^\]]+)\]{1,2}/;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type NuxtFileRole =
  | "page"
  | "layout"
  | "middleware"
  | "plugin"
  | "composable"
  | "server-route"
  | "server-middleware"
  | "server-plugin"
  | "util"
  | "config"
  | "app-vue"
  | "error-vue"
  | "component"
  | "regular";

interface NuxtFileInfo {
  readonly filePath: string;
  readonly role: NuxtFileRole;
  readonly nuxtDir: string | null;
  readonly routePath: string | null;
  readonly dynamicSegments: readonly string[];
  readonly exportNames: readonly string[];
  readonly isDefaultExport: boolean;
  readonly hasDefineNuxtConfig: boolean;
  readonly hasDefinePageMeta: boolean;
  readonly hasDefineNuxtMiddleware: boolean;
  readonly hasDefineNuxtPlugin: boolean;
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

function extractDynamicSegments(relativePath: string): string[] {
  const parts = normalizeToPosix(relativePath).split("/");
  const segments: string[] = [];
  for (const part of parts) {
    const match = DYNAMIC_SEGMENT_RE.exec(part);
    if (match !== null) segments.push(match[1]!);
  }
  return segments;
}

function computeNuxtRoutePath(relativePath: string): string | null {
  const norm = normalizeToPosix(relativePath);

  let prefix: string;
  if (norm.startsWith("pages/")) prefix = "pages/";
  else if (norm.startsWith("src/pages/")) prefix = "src/pages/";
  else return null;

  const stripped = norm.slice(prefix.length);
  const dir = getFileDir(stripped);
  const baseName = getBaseName(stripped);

  const routeParts: string[] = dir !== "" ? dir.split("/") : [];

  // In Nuxt, index.vue → /, [id].vue → /:id
  if (baseName !== "index") {
    routeParts.push(baseName);
  }

  const mapped = routeParts.map((p) => {
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(p);
    if (catchAll !== null) return `*${catchAll[1]}`;
    const optional = /^\[\[([^\]]+)\]\]$/.exec(p);
    if (optional !== null) return `:${optional[1]}?`;
    const dyn = /^\[([^\]]+)\]$/.exec(p);
    if (dyn !== null) return `:${dyn[1]}`;
    return p;
  });

  return "/" + mapped.join("/");
}

function computeServerRoutePath(relativePath: string): string | null {
  const norm = normalizeToPosix(relativePath);

  let prefix: string;
  if (norm.startsWith("server/api/")) prefix = "server/api/";
  else if (norm.startsWith("server/routes/")) prefix = "server/routes/";
  else return null;

  const stripped = norm.slice(prefix.length);
  const dir = getFileDir(stripped);
  const baseName = getBaseName(stripped);

  const routeParts: string[] = dir !== "" ? dir.split("/") : [];
  if (baseName !== "index") {
    routeParts.push(baseName);
  }

  const apiPrefix = norm.startsWith("server/api/") ? "/api" : "";
  return apiPrefix + "/" + routeParts.join("/");
}

function getNuxtDir(relativePath: string): string | null {
  const norm = normalizeToPosix(relativePath);
  // Handle src/ prefix
  const cleaned = norm.startsWith("src/") ? norm.slice(4) : norm;
  const firstSlash = cleaned.indexOf("/");
  if (firstSlash < 0) return null;
  const dir = cleaned.slice(0, firstSlash);
  return NUXT_DIRS.has(dir) ? dir : null;
}

// ---------------------------------------------------------------------------
// NuxtAnalyzer
// ---------------------------------------------------------------------------

export class NuxtAnalyzer implements Analyzer {
  readonly name = "nuxt";
  readonly version = "1.0.0";
  readonly capabilities = [
    "nuxt-page-detection",
    "nuxt-layout-detection",
    "nuxt-composable-detection",
    "nuxt-middleware-detection",
    "nuxt-server-route-detection",
    "nuxt-plugin-detection",
    "nuxt-auto-import-detection",
  ] as const;
  readonly dependencies = ["component"] as const;

  private runDiagnostics: AnalyzerDiagnostic[] = [];

  fileFilter(file: DiscoveredFile): boolean {
    return NUXT_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const startedAt = Date.now();
    this.runDiagnostics = [];

    if (!this.isNuxtProject(context.files)) {
      return this.buildEmptyOutput(startedAt, context.files.length);
    }

    const sortedFiles = [...context.files].sort((a, b) =>
      compare(normalizeToPosix(a.relativePath), normalizeToPosix(b.relativePath)),
    );

    let cacheHits = 0;
    let cacheMisses = 0;
    const fileInfos: NuxtFileInfo[] = [];

    for (const file of sortedFiles) {
      if (context.signal?.aborted === true) break;

      if (!this.isNuxtRelevant(file)) continue;

      const key = `nuxt:${file.relativePath}` as CacheKey;
      const cached = context.cache.get<NuxtFileInfo>(key);

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
        composableCount: fileInfos.filter((f) => f.role === "composable").length,
        middlewareCount: fileInfos.filter((f) => f.role === "middleware").length,
        pluginCount: fileInfos.filter((f) => f.role === "plugin").length,
        serverRouteCount: fileInfos.filter((f) => f.role === "server-route").length,
        utilCount: fileInfos.filter((f) => f.role === "util").length,
        autoImportDirs: [...AUTO_IMPORT_DIRS].filter((dir) =>
          fileInfos.some((f) => getNuxtDir(f.filePath) === dir),
        ),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Project detection
  // -------------------------------------------------------------------------

  private isNuxtProject(files: readonly DiscoveredFile[]): boolean {
    for (const file of files) {
      const norm = normalizeToPosix(file.relativePath);
      if (norm === "nuxt.config.ts" || norm === "nuxt.config.js" || norm === "nuxt.config.mjs") {
        return true;
      }
    }
    return false;
  }

  private isNuxtRelevant(file: DiscoveredFile): boolean {
    const norm = normalizeToPosix(file.relativePath);
    const baseName = getBaseName(norm);

    // Config files at root
    if (baseName === "nuxt.config" && !norm.includes("/")) return true;
    if ((baseName === "app" || baseName === "error") && !norm.includes("/") && file.extension === "vue") return true;

    // Files inside Nuxt special directories
    const nuxtDir = getNuxtDir(norm);
    if (nuxtDir !== null) return true;

    return false;
  }

  // -------------------------------------------------------------------------
  // File analysis
  // -------------------------------------------------------------------------

  private async analyzeFile(file: DiscoveredFile): Promise<NuxtFileInfo> {
    const norm = normalizeToPosix(file.relativePath);
    const baseName = getBaseName(norm);

    let content: string;
    try {
      content = await readFile(file.absolutePath, "utf-8");
    } catch {
      return this.makeRegularInfo(file);
    }

    const exportNames = this.extractExportNames(content);
    const isDefaultExport = this.hasDefaultExport(content);
    const hasDefineNuxtConfig = content.includes("defineNuxtConfig");
    const hasDefinePageMeta = content.includes("definePageMeta");
    const hasDefineNuxtMiddleware = content.includes("defineNuxtRouteMiddleware");
    const hasDefineNuxtPlugin = content.includes("defineNuxtPlugin");

    // Root-level files
    if (!norm.includes("/")) {
      if (baseName === "nuxt.config") {
        return {
          filePath: norm,
          role: "config",
          nuxtDir: null,
          routePath: null,
          dynamicSegments: [],
          exportNames,
          isDefaultExport,
          hasDefineNuxtConfig,
          hasDefinePageMeta,
          hasDefineNuxtMiddleware,
          hasDefineNuxtPlugin,
        };
      }
      if (baseName === "app" && file.extension === "vue") {
        return {
          filePath: norm,
          role: "app-vue",
          nuxtDir: null,
          routePath: null,
          dynamicSegments: [],
          exportNames,
          isDefaultExport,
          hasDefineNuxtConfig,
          hasDefinePageMeta,
          hasDefineNuxtMiddleware,
          hasDefineNuxtPlugin,
        };
      }
      if (baseName === "error" && file.extension === "vue") {
        return {
          filePath: norm,
          role: "error-vue",
          nuxtDir: null,
          routePath: null,
          dynamicSegments: [],
          exportNames,
          isDefaultExport,
          hasDefineNuxtConfig,
          hasDefinePageMeta,
          hasDefineNuxtMiddleware,
          hasDefineNuxtPlugin,
        };
      }
    }

    const nuxtDir = getNuxtDir(norm);
    const role = this.detectRole(norm, nuxtDir, file.extension);
    const dynamicSegments = extractDynamicSegments(norm);

    let routePath: string | null = null;
    if (role === "page") {
      routePath = computeNuxtRoutePath(norm);
    } else if (role === "server-route") {
      routePath = computeServerRoutePath(norm);
    }

    return {
      filePath: norm,
      role,
      nuxtDir,
      routePath,
      dynamicSegments,
      exportNames,
      isDefaultExport,
      hasDefineNuxtConfig,
      hasDefinePageMeta,
      hasDefineNuxtMiddleware,
      hasDefineNuxtPlugin,
    };
  }

  private detectRole(
    norm: string,
    nuxtDir: string | null,
    _extension: string,
  ): NuxtFileRole {
    if (nuxtDir === null) return "regular";

    switch (nuxtDir) {
      case "pages": return "page";
      case "layouts": return "layout";
      case "middleware": return "middleware";
      case "plugins": return "plugin";
      case "composables": return "composable";
      case "utils": return "util";
      case "components": return "component";
      case "server": {
        // server/api/, server/routes/, server/middleware/, server/plugins/
        const cleaned = norm.startsWith("src/") ? norm.slice(4) : norm;
        if (cleaned.startsWith("server/api/") || cleaned.startsWith("server/routes/")) return "server-route";
        if (cleaned.startsWith("server/middleware/")) return "server-middleware";
        if (cleaned.startsWith("server/plugins/")) return "server-plugin";
        return "server-route";
      }
      default: return "regular";
    }
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

  private buildPatterns(fileInfos: readonly NuxtFileInfo[]): PatternResult[] {
    const patterns: PatternResult[] = [];

    // Summary pattern
    patterns.push(this.buildSummaryPattern(fileInfos));

    // Per-file patterns for non-regular/non-config files
    for (const info of fileInfos) {
      if (info.role === "regular" || info.role === "config") continue;
      patterns.push(this.buildFilePattern(info));
    }

    return patterns;
  }

  private buildSummaryPattern(fileInfos: readonly NuxtFileInfo[]): PatternResult {
    const pages = fileInfos.filter((f) => f.role === "page");
    const layouts = fileInfos.filter((f) => f.role === "layout");
    const composables = fileInfos.filter((f) => f.role === "composable");
    const middlewares = fileInfos.filter((f) => f.role === "middleware");
    const plugins = fileInfos.filter((f) => f.role === "plugin");
    const serverRoutes = fileInfos.filter((f) => f.role === "server-route");

    return {
      id: `.:nuxt-framework:1` as PatternId,
      type: "utility" as PatternType,
      name: "nuxt-framework",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      confidence: {
        value: 1.0,
        source: "nuxt-detection",
        factors: [{ name: "nuxt-config", weight: 1.0, score: 1.0 }],
      },
      framework: "vue",
      dependencies: [],
      properties: {},
      metadata: {
        pageCount: pages.length,
        layoutCount: layouts.length,
        composableCount: composables.length,
        middlewareCount: middlewares.length,
        pluginCount: plugins.length,
        serverRouteCount: serverRoutes.length,
        routes: pages.map((f) => f.routePath).filter(Boolean).sort() as string[],
        serverRoutes: serverRoutes.map((f) => f.routePath).filter(Boolean).sort() as string[],
      },
    };
  }

  private buildFilePattern(info: NuxtFileInfo): PatternResult {
    const patternType = this.roleToPatternType(info.role);
    const name = this.buildPatternName(info);
    const confidence = this.buildConfidence(info);

    const metadata: Record<string, unknown> = {
      nuxtRole: info.role,
    };

    if (info.nuxtDir !== null) metadata["nuxtDir"] = info.nuxtDir;
    if (info.routePath !== null) metadata["routePath"] = info.routePath;
    if (info.dynamicSegments.length > 0) metadata["dynamicSegments"] = info.dynamicSegments;
    if (info.hasDefinePageMeta) metadata["hasDefinePageMeta"] = true;
    if (info.hasDefineNuxtMiddleware) metadata["hasDefineNuxtMiddleware"] = true;
    if (info.hasDefineNuxtPlugin) metadata["hasDefineNuxtPlugin"] = true;
    if (info.exportNames.length > 0) metadata["exports"] = info.exportNames;

    return {
      id: `${info.filePath}:${name}:1` as PatternId,
      type: patternType,
      name,
      filePath: info.filePath,
      location: { file: info.filePath, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      confidence,
      framework: "vue",
      dependencies: [],
      properties: {},
      metadata,
    };
  }

  private roleToPatternType(role: NuxtFileRole): PatternType {
    switch (role) {
      case "page": return "page";
      case "layout": return "layout";
      case "composable": return "composable";
      case "middleware": return "utility";
      case "plugin": return "utility";
      case "server-route": return "utility";
      case "server-middleware": return "utility";
      case "server-plugin": return "utility";
      case "util": return "utility";
      case "app-vue": return "layout";
      case "error-vue": return "component";
      case "component": return "component";
      default: return "component";
    }
  }

  private buildPatternName(info: NuxtFileInfo): string {
    const baseName = getBaseName(info.filePath);

    switch (info.role) {
      case "page": {
        const route = info.routePath ?? "/";
        return `Page:${route}`;
      }
      case "layout":
        return `Layout:${baseName}`;
      case "composable":
        return baseName;
      case "middleware":
        return `Middleware:${baseName}`;
      case "plugin":
        return `Plugin:${baseName}`;
      case "server-route": {
        const route = info.routePath ?? baseName;
        return `ServerRoute:${route}`;
      }
      case "server-middleware":
        return `ServerMiddleware:${baseName}`;
      case "server-plugin":
        return `ServerPlugin:${baseName}`;
      case "util":
        return baseName;
      case "app-vue":
        return "App";
      case "error-vue":
        return "ErrorPage";
      case "component":
        return baseName.charAt(0).toUpperCase() + baseName.slice(1);
      default:
        return baseName;
    }
  }

  private buildConfidence(info: NuxtFileInfo): ConfidenceScore {
    const factors = [];
    let total = 0;

    // Directory placement is a strong signal for Nuxt
    if (info.nuxtDir !== null) {
      factors.push({ name: "nuxt-directory", weight: 0.6, score: 1.0 });
      total += 0.6;
    } else {
      factors.push({ name: "nuxt-directory", weight: 0.6, score: 0.3 });
      total += 0.18;
    }

    // Nuxt macros are very strong signals
    const hasMacro = info.hasDefinePageMeta || info.hasDefineNuxtMiddleware || info.hasDefineNuxtPlugin;
    if (hasMacro) {
      factors.push({ name: "nuxt-macro", weight: 0.4, score: 1.0 });
      total += 0.4;
    } else {
      factors.push({ name: "nuxt-macro", weight: 0.4, score: 0.3 });
      total += 0.12;
    }

    return {
      value: Math.min(1.0, total),
      source: "nuxt-analysis",
      factors,
    };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  private addDiagnostics(
    fileInfos: readonly NuxtFileInfo[],
    diagnostics: AnalyzerDiagnostic[],
  ): void {
    // Warn about pages without definePageMeta (info-level — it's optional)
    const pages = fileInfos.filter((f) => f.role === "page");
    for (const page of pages) {
      if (!page.hasDefinePageMeta && page.dynamicSegments.length > 0) {
        diagnostics.push({
          severity: "info",
          filePath: page.filePath,
          message: `Dynamic page without definePageMeta — consider adding route validation.`,
          line: 1,
        });
      }
    }

    // Warn about composables not starting with "use"
    const composables = fileInfos.filter((f) => f.role === "composable");
    for (const comp of composables) {
      const baseName = getBaseName(comp.filePath);
      if (!baseName.startsWith("use")) {
        diagnostics.push({
          severity: "info",
          filePath: comp.filePath,
          message: `Composable "${baseName}" does not follow the "use" prefix convention.`,
          line: 1,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private makeRegularInfo(file: DiscoveredFile): NuxtFileInfo {
    return {
      filePath: normalizeToPosix(file.relativePath),
      role: "regular",
      nuxtDir: null,
      routePath: null,
      dynamicSegments: [],
      exportNames: [],
      isDefaultExport: false,
      hasDefineNuxtConfig: false,
      hasDefinePageMeta: false,
      hasDefineNuxtMiddleware: false,
      hasDefineNuxtPlugin: false,
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
