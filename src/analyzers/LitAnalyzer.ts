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

const LIT_EXTENSIONS = new Set(["ts", "js"]);

/** Framework detection */
const LIT_IMPORT_RE = /from\s+['"]lit['"]/;
const LIT_ELEMENT_IMPORT_RE = /from\s+['"]lit-element['"]/;
const LIT_DECORATORS_RE = /from\s+['"]lit\/decorators(?:\.js)?['"]/;

/** Class extends LitElement */
const EXTENDS_LIT_RE = /class\s+(\w+)\s+extends\s+(?:Lit(?:Element)?)\s*\{/g;

/** @customElement decorator */
const CUSTOM_ELEMENT_RE = /@customElement\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Property decorators */
const PROPERTY_DECORATOR_RE = /@property\s*\(/g;
const STATE_DECORATOR_RE = /@state\s*\(/g;

/** Static styles */
const STATIC_STYLES_RE = /static\s+(?:get\s+)?styles\s*[=:]/g;
const CSS_TAG_RE = /\bcss\s*`/g;

/** html template literal */
const HTML_TAG_RE = /\bhtml\s*`/g;

/** Slot usage in templates */
const SLOT_RE = /<slot\b/g;

/** Static properties for non-decorator usage */
const STATIC_PROPERTIES_RE = /static\s+(?:get\s+)?properties\s*[=:]/g;

/** define() call for non-decorator registration */
const CUSTOM_ELEMENTS_DEFINE_RE = /customElements\.define\s*\(\s*['"]([^'"]+)['"]/g;

/** Reactive controller */
const REACTIVE_CONTROLLER_RE = /implements\s+ReactiveController/g;
const ADD_CONTROLLER_RE = /this\.addController\s*\(/g;

/** Query decorators */
const QUERY_RE = /@query\s*\(/g;
const QUERY_ALL_RE = /@queryAll\s*\(/g;
const QUERY_ASYNC_RE = /@queryAsync\s*\(/g;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface LitComponent {
  readonly className: string;
  readonly tagName: string | null;
}

interface LitFileMetrics {
  readonly filePath: string;
  readonly isLit: boolean;
  readonly components: readonly LitComponent[];
  readonly propertyCount: number;
  readonly stateCount: number;
  readonly hasStaticStyles: boolean;
  readonly cssTagCount: number;
  readonly htmlTagCount: number;
  readonly slotCount: number;
  readonly hasStaticProperties: boolean;
  readonly controllerCount: number;
  readonly queryCount: number;
}

// -----------------------------------------------------------------------------
// LitAnalyzer
// -----------------------------------------------------------------------------

export class LitAnalyzer implements Analyzer {
  readonly name = "lit";
  readonly version = "1.0.0";
  readonly capabilities = [
    "lit-element-detection",
    "custom-element-detection",
    "property-detection",
    "state-detection",
    "styles-detection",
    "template-detection",
    "slot-detection",
    "controller-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return LIT_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: LitFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `lit:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<LitFileMetrics>(cacheKey);
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

      const metrics = analyzeLitFile(file, content);
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Only produce output if Lit detected
    const litFiles = allMetrics.filter((m) => m.isLit);
    if (litFiles.length === 0) {
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
    let totalComponents = 0;
    let totalProperties = 0;
    let totalStates = 0;
    let totalSlots = 0;
    let totalControllers = 0;
    let filesWithShadowDom = 0;

    for (const m of litFiles) {
      totalComponents += m.components.length;
      totalProperties += m.propertyCount;
      totalStates += m.stateCount;
      totalSlots += m.slotCount;
      totalControllers += m.controllerCount;
      if (m.hasStaticStyles || m.cssTagCount > 0) filesWithShadowDom++;

      // Per-component patterns
      for (const comp of m.components) {
        const displayName = comp.tagName ?? comp.className;
        const pid = `${m.filePath}:component:${displayName}` as PatternId;
        patterns.push({
          id: pid,
          type: "component" as PatternType,
          name: displayName,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.95,
            source: "lit-detection",
            factors: [{ name: "lit-element-class", weight: 1, score: 0.95 }],
          },
          framework: "lit",
          dependencies: [],
          properties: {},
          metadata: {
            className: comp.className,
            tagName: comp.tagName,
            propertyCount: m.propertyCount,
            stateCount: m.stateCount,
            hasStaticStyles: m.hasStaticStyles,
            slotCount: m.slotCount,
            htmlTemplateCount: m.htmlTagCount,
          },
        });
      }

      // Controller patterns
      if (m.controllerCount > 0) {
        const pid = `${m.filePath}:controller:1` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `controller:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.85,
            source: "lit-detection",
            factors: [{ name: "reactive-controller", weight: 1, score: 0.85 }],
          },
          framework: "lit",
          dependencies: [],
          properties: {},
          metadata: { controllerCount: m.controllerCount },
        });
      }
    }

    // Summary pattern
    const summaryId = `.:lit-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "lit-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.95,
        source: "lit-analysis",
        factors: [{ name: "framework-detection", weight: 1, score: 0.95 }],
      },
      framework: "lit",
      dependencies: [],
      properties: {},
      metadata: {
        totalComponents,
        totalProperties,
        totalStates,
        totalSlots,
        totalControllers,
        filesWithShadowDom,
        litFileCount: litFiles.length,
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

function analyzeLitFile(file: DiscoveredFile, content: string): LitFileMetrics {
  const isLit = LIT_IMPORT_RE.test(content) ||
    LIT_ELEMENT_IMPORT_RE.test(content) ||
    LIT_DECORATORS_RE.test(content);

  if (!isLit) {
    return {
      filePath: file.relativePath,
      isLit: false,
      components: [],
      propertyCount: 0,
      stateCount: 0,
      hasStaticStyles: false,
      cssTagCount: 0,
      htmlTagCount: 0,
      slotCount: 0,
      hasStaticProperties: false,
      controllerCount: 0,
      queryCount: 0,
    };
  }

  const components: LitComponent[] = [];

  // Collect tag names from @customElement decorators
  const tagNames = new Map<string, string>();
  const ceRe = new RegExp(CUSTOM_ELEMENT_RE.source, CUSTOM_ELEMENT_RE.flags);
  let match: RegExpExecArray | null;
  // Store positions of @customElement to match with following class
  const cePositions: Array<{ tagName: string; endIdx: number }> = [];
  while ((match = ceRe.exec(content)) !== null) {
    cePositions.push({ tagName: match[1]!, endIdx: match.index + match[0].length });
  }

  // Collect from customElements.define
  const defRe = new RegExp(CUSTOM_ELEMENTS_DEFINE_RE.source, CUSTOM_ELEMENTS_DEFINE_RE.flags);
  while ((match = defRe.exec(content)) !== null) {
    // Try to find the class name after the tag name in define call
    const afterDefine = content.slice(match.index);
    const classMatch = afterDefine.match(/customElements\.define\s*\(\s*['"][^'"]+['"]\s*,\s*(\w+)/);
    if (classMatch) {
      tagNames.set(classMatch[1]!, match[1]!);
    }
  }

  // Collect classes extending LitElement
  const extendsRe = new RegExp(EXTENDS_LIT_RE.source, EXTENDS_LIT_RE.flags);
  while ((match = extendsRe.exec(content)) !== null) {
    const className = match[1]!;

    // Check if there's a @customElement decorator immediately before this class
    let tagName: string | null = tagNames.get(className) ?? null;
    if (tagName === null) {
      for (const ce of cePositions) {
        // The decorator should appear shortly before the class keyword
        const between = content.slice(ce.endIdx, match.index).trim();
        if (between.length === 0 || /^export\s*$/.test(between) || /^\s*$/.test(between)) {
          tagName = ce.tagName;
          break;
        }
      }
    }

    components.push({ className, tagName });
  }

  const propertyCount = countMatches(content, PROPERTY_DECORATOR_RE);
  const stateCount = countMatches(content, STATE_DECORATOR_RE);
  const hasStaticStyles = countMatches(content, STATIC_STYLES_RE) > 0;
  const cssTagCount = countMatches(content, CSS_TAG_RE);
  const htmlTagCount = countMatches(content, HTML_TAG_RE);
  const slotCount = countMatches(content, SLOT_RE);
  const hasStaticProperties = countMatches(content, STATIC_PROPERTIES_RE) > 0;
  const controllerCount = countMatches(content, REACTIVE_CONTROLLER_RE) + countMatches(content, ADD_CONTROLLER_RE);
  const queryCount = countMatches(content, QUERY_RE) + countMatches(content, QUERY_ALL_RE) + countMatches(content, QUERY_ASYNC_RE);

  return {
    filePath: file.relativePath,
    isLit: true,
    components,
    propertyCount,
    stateCount,
    hasStaticStyles,
    cssTagCount,
    htmlTagCount,
    slotCount,
    hasStaticProperties,
    controllerCount,
    queryCount,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function countMatches(content: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags);
  let count = 0;
  while (re.exec(content) !== null) count++;
  return count;
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
