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
// Constants & Regex patterns
// -----------------------------------------------------------------------------

const NG_EXTENSIONS = new Set(["ts"]);
const EXCLUDE_SUFFIXES = [".spec.ts", ".test.ts", ".d.ts"];

/** Decorator matchers */
const COMPONENT_RE = /@Component\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const INJECTABLE_RE = /@Injectable\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const NGMODULE_RE = /@NgModule\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const DIRECTIVE_RE = /@Directive\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const PIPE_RE = /@Pipe\s*\(\s*\{([\s\S]*?)\}\s*\)/g;

/** Property decorators */
const INPUT_RE = /@Input\s*\(/g;
const OUTPUT_RE = /@Output\s*\(/g;

/** Route definitions */
const ROUTE_RE = /\{\s*path\s*:\s*['"]([^'"]*)['"]\s*,\s*(?:component|loadChildren|loadComponent)\s*:/g;

/** Angular signals */
const SIGNAL_RE = /\bsignal\s*[<(]/g;
const COMPUTED_RE = /\bcomputed\s*\(/g;
const EFFECT_RE = /\beffect\s*\(/g;

/** Standalone detection */
const STANDALONE_RE = /standalone\s*:\s*true/;

/** Selector extraction */
const SELECTOR_RE = /selector\s*:\s*['"]([^'"]+)['"]/;

/** templateUrl extraction */
const TEMPLATE_URL_RE = /templateUrl\s*:\s*['"]([^'"]+)['"]/;

/** providedIn extraction */
const PROVIDED_IN_RE = /providedIn\s*:\s*['"]([^'"]+)['"]/;

/** Subscription pattern — .subscribe( */
const SUBSCRIBE_RE = /\.subscribe\s*\(/g;

/** OnDestroy implementation */
const ON_DESTROY_RE = /\bOnDestroy\b/;

/** Array member counting */
const DECLARATIONS_RE = /declarations\s*:\s*\[([\s\S]*?)\]/;
const IMPORTS_RE = /imports\s*:\s*\[([\s\S]*?)\]/;
const EXPORTS_RE = /exports\s*:\s*\[([\s\S]*?)\]/;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface AngularFileMetrics {
  readonly filePath: string;
  readonly components: readonly AngularComponent[];
  readonly services: readonly AngularService[];
  readonly modules: readonly AngularModule[];
  readonly directives: number;
  readonly pipes: number;
  readonly inputs: number;
  readonly outputs: number;
  readonly routes: readonly string[];
  readonly signals: number;
  readonly computeds: number;
  readonly effects: number;
  readonly hasSubscriptions: boolean;
  readonly hasOnDestroy: boolean;
}

interface AngularComponent {
  readonly selector: string | null;
  readonly standalone: boolean;
  readonly templateUrl: string | null;
}

interface AngularService {
  readonly providedIn: string | null;
}

interface AngularModule {
  readonly declarationCount: number;
  readonly importCount: number;
  readonly exportCount: number;
}

// -----------------------------------------------------------------------------
// AngularAnalyzer
// -----------------------------------------------------------------------------

export class AngularAnalyzer implements Analyzer {
  readonly name = "angular";
  readonly version = "1.0.0";
  readonly capabilities = [
    "component-detection",
    "service-detection",
    "module-detection",
    "directive-detection",
    "pipe-detection",
    "route-detection",
    "signal-detection",
    "standalone-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    if (!NG_EXTENSIONS.has(file.extension)) return false;
    for (const suffix of EXCLUDE_SUFFIXES) {
      if (file.relativePath.endsWith(suffix)) return false;
    }
    return true;
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: AngularFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `angular:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<AngularFileMetrics>(cacheKey);
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

      const metrics = analyzeAngularFile(file, content);
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Check if Angular framework is detected at all
    const hasAngular = allMetrics.some(
      (m) => m.components.length > 0 || m.modules.length > 0,
    );

    if (!hasAngular) {
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

    // Aggregate totals
    let totalComponents = 0;
    let totalServices = 0;
    let totalModules = 0;
    let totalDirectives = 0;
    let totalPipes = 0;
    let totalRoutes = 0;
    let totalSignals = 0;
    let totalInputs = 0;
    let totalOutputs = 0;
    let standaloneCount = 0;

    for (const m of allMetrics) {
      totalComponents += m.components.length;
      totalServices += m.services.length;
      totalModules += m.modules.length;
      totalDirectives += m.directives;
      totalPipes += m.pipes;
      totalRoutes += m.routes.length;
      totalSignals += m.signals + m.computeds + m.effects;
      totalInputs += m.inputs;
      totalOutputs += m.outputs;
      for (const c of m.components) {
        if (c.standalone) standaloneCount++;
      }

      // Per-file patterns
      for (const comp of m.components) {
        const patternName = comp.selector ?? extractFileName(m.filePath);
        const pid = `${m.filePath}:component:${patternName}` as PatternId;
        patterns.push({
          id: pid,
          type: "component" as PatternType,
          name: patternName,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.95,
            source: "decorator-detection",
            factors: [{ name: "angular-component-decorator", weight: 1, score: 0.95 }],
          },
          framework: "angular",
          dependencies: [],
          properties: {},
          metadata: {
            selector: comp.selector,
            standalone: comp.standalone,
            templateUrl: comp.templateUrl,
            inputCount: m.inputs,
            outputCount: m.outputs,
          },
        });

        // ANG002: non-standalone component
        if (!comp.standalone) {
          diagnostics.push({
            severity: "info",
            filePath: m.filePath,
            message: `ANG002 Component '${patternName}' is not standalone. Consider migrating to standalone components.`,
          });
        }
      }

      for (const svc of m.services) {
        const svcName = extractFileName(m.filePath);
        const pid = `${m.filePath}:service:${svcName}` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: svcName,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "decorator-detection",
            factors: [{ name: "angular-injectable-decorator", weight: 1, score: 0.9 }],
          },
          framework: "angular",
          dependencies: [],
          properties: {},
          metadata: { providedIn: svc.providedIn },
        });

        // ANG003: service without providedIn
        if (svc.providedIn === null) {
          diagnostics.push({
            severity: "warning",
            filePath: m.filePath,
            message: `ANG003 Service '${svcName}' lacks providedIn. Consider using providedIn: 'root' for tree-shaking.`,
          });
        }
      }

      if (m.directives > 0) {
        const dirName = extractFileName(m.filePath);
        const pid = `${m.filePath}:directive:${dirName}` as PatternId;
        patterns.push({
          id: pid,
          type: "directive" as PatternType,
          name: dirName,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "decorator-detection",
            factors: [{ name: "angular-directive-decorator", weight: 1, score: 0.9 }],
          },
          framework: "angular",
          dependencies: [],
          properties: {},
          metadata: { directiveCount: m.directives },
        });
      }

      if (m.pipes > 0) {
        const pipeName = extractFileName(m.filePath);
        const pid = `${m.filePath}:pipe:${pipeName}` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: pipeName,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "decorator-detection",
            factors: [{ name: "angular-pipe-decorator", weight: 1, score: 0.9 }],
          },
          framework: "angular",
          dependencies: [],
          properties: {},
          metadata: { pipeCount: m.pipes },
        });
      }

      // ANG001: subscriptions without OnDestroy
      if (m.hasSubscriptions && !m.hasOnDestroy && m.components.length > 0) {
        diagnostics.push({
          severity: "warning",
          filePath: m.filePath,
          message: `ANG001 Component has .subscribe() calls but does not implement OnDestroy. Potential memory leak.`,
        });
      }
    }

    // Summary pattern
    const summaryId = `.:angular-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "angular-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.95,
        source: "angular-analysis",
        factors: [{ name: "framework-detection", weight: 1, score: 0.95 }],
      },
      framework: "angular",
      dependencies: [],
      properties: {},
      metadata: {
        totalComponents,
        totalServices,
        totalModules,
        totalDirectives,
        totalPipes,
        totalRoutes,
        totalSignals,
        totalInputs,
        totalOutputs,
        standaloneCount,
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

function analyzeAngularFile(file: DiscoveredFile, content: string): AngularFileMetrics {
  const components: AngularComponent[] = [];
  const services: AngularService[] = [];
  const modules: AngularModule[] = [];

  // Components
  let match: RegExpExecArray | null;
  const componentRe = new RegExp(COMPONENT_RE.source, COMPONENT_RE.flags);
  while ((match = componentRe.exec(content)) !== null) {
    const body = match[1] ?? "";
    const selectorMatch = body.match(SELECTOR_RE);
    const standalone = STANDALONE_RE.test(body);
    const templateUrlMatch = body.match(TEMPLATE_URL_RE);
    components.push({
      selector: selectorMatch ? selectorMatch[1]! : null,
      standalone,
      templateUrl: templateUrlMatch ? templateUrlMatch[1]! : null,
    });
  }

  // Injectable
  const injectableRe = new RegExp(INJECTABLE_RE.source, INJECTABLE_RE.flags);
  while ((match = injectableRe.exec(content)) !== null) {
    const body = match[1] ?? "";
    const providedInMatch = body.match(PROVIDED_IN_RE);
    services.push({
      providedIn: providedInMatch ? providedInMatch[1]! : null,
    });
  }

  // NgModule
  const ngModuleRe = new RegExp(NGMODULE_RE.source, NGMODULE_RE.flags);
  while ((match = ngModuleRe.exec(content)) !== null) {
    const body = match[1] ?? "";
    const declMatch = body.match(DECLARATIONS_RE);
    const impMatch = body.match(IMPORTS_RE);
    const expMatch = body.match(EXPORTS_RE);
    modules.push({
      declarationCount: countArrayItems(declMatch ? declMatch[1]! : ""),
      importCount: countArrayItems(impMatch ? impMatch[1]! : ""),
      exportCount: countArrayItems(expMatch ? expMatch[1]! : ""),
    });
  }

  // Directives
  const directiveRe = new RegExp(DIRECTIVE_RE.source, DIRECTIVE_RE.flags);
  let directives = 0;
  while (directiveRe.exec(content) !== null) directives++;

  // Pipes
  const pipeRe = new RegExp(PIPE_RE.source, PIPE_RE.flags);
  let pipes = 0;
  while (pipeRe.exec(content) !== null) pipes++;

  // Inputs / Outputs
  const inputRe = new RegExp(INPUT_RE.source, INPUT_RE.flags);
  let inputs = 0;
  while (inputRe.exec(content) !== null) inputs++;

  const outputRe = new RegExp(OUTPUT_RE.source, OUTPUT_RE.flags);
  let outputs = 0;
  while (outputRe.exec(content) !== null) outputs++;

  // Routes
  const routes: string[] = [];
  const routeRe = new RegExp(ROUTE_RE.source, ROUTE_RE.flags);
  while ((match = routeRe.exec(content)) !== null) {
    routes.push(match[1]!);
  }

  // Signals
  const signalRe = new RegExp(SIGNAL_RE.source, SIGNAL_RE.flags);
  let signals = 0;
  while (signalRe.exec(content) !== null) signals++;

  const computedRe = new RegExp(COMPUTED_RE.source, COMPUTED_RE.flags);
  let computeds = 0;
  while (computedRe.exec(content) !== null) computeds++;

  const effectRe = new RegExp(EFFECT_RE.source, EFFECT_RE.flags);
  let effects = 0;
  while (effectRe.exec(content) !== null) effects++;

  // Subscriptions and OnDestroy
  const subscribeRe = new RegExp(SUBSCRIBE_RE.source, SUBSCRIBE_RE.flags);
  let subCount = 0;
  while (subscribeRe.exec(content) !== null) subCount++;
  const hasSubscriptions = subCount > 0;
  const hasOnDestroy = ON_DESTROY_RE.test(content);

  return {
    filePath: file.relativePath,
    components,
    services,
    modules,
    directives,
    pipes,
    inputs,
    outputs,
    routes,
    signals,
    computeds,
    effects,
    hasSubscriptions,
    hasOnDestroy,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function countArrayItems(arrayContent: string): number {
  if (arrayContent.trim().length === 0) return 0;
  return arrayContent.split(",").filter((s) => s.trim().length > 0).length;
}

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
