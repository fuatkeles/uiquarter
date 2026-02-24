import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compare } from "../core/utils.js";
import type {
  DependencyEdge,
  IntelligenceIndex,
  IndexStats,
  PatternId,
  PatternResult,
  PatternType,
  OutputHash,
} from "../types/index.js";
import type {
  Insight,
  InsightSeverity,
  InsightType,
} from "../types/insight.js";
import { InvertedIndex } from "./InvertedIndex.js";
import { ResolverScorer } from "./ResolverScorer.js";
import type { ScoredMatch } from "./ResolverScorer.js";

// -----------------------------------------------------------------------------
// Serialized shapes (mirrors IntelligenceIndexer output)
// -----------------------------------------------------------------------------

interface SerializedIndex {
  readonly schemaVersion?: number;
  readonly buildNumber: number;
  readonly compositeHash: string;
  readonly entries: Readonly<Record<string, unknown>>;
  readonly edges: readonly unknown[];
  readonly fileIndex: Readonly<Record<string, readonly string[]>>;
  readonly typeIndex: Readonly<Record<string, readonly string[]>>;
  readonly stats: unknown;
}

interface SerializedInsights {
  readonly version: string;
  readonly hash: string;
  readonly insights: readonly unknown[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SEVERITY_ORDER: Record<InsightSeverity, number> = { error: 0, warning: 1, info: 2 };

const COMPONENT_TYPES = new Set<PatternType>([
  "component",
  "hook",
  "hoc",
  "provider",
  "page",
  "layout",
  "directive",
  "composable",
]);

// -----------------------------------------------------------------------------
// QueryEngine
// -----------------------------------------------------------------------------

export class QueryEngine {
  private readonly rootPath: string;
  private index: IntelligenceIndex | null = null;
  private insights: readonly Insight[] = [];

  private patternsByName = new Map<string, PatternResult>();
  private patternsById = new Map<PatternId, PatternResult>();
  private dependentsMap = new Map<PatternId, PatternId[]>();
  private dependenciesMap = new Map<PatternId, PatternId[]>();
  private invertedIndex: InvertedIndex | null = null;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  async load(): Promise<void> {
    const uiqDir = join(this.rootPath, ".uiq");

    // Read index.json
    let indexRaw: string;
    try {
      indexRaw = await readFile(join(uiqDir, "index.json"), "utf-8");
    } catch {
      throw new Error(`QueryEngine: could not read ${join(uiqDir, "index.json")} — run "uiquarter init" first`);
    }

    // Read insights.json
    let insightsRaw: string;
    try {
      insightsRaw = await readFile(join(uiqDir, "insights.json"), "utf-8");
    } catch {
      throw new Error(`QueryEngine: could not read ${join(uiqDir, "insights.json")} — run "uiquarter init" first`);
    }

    let serializedIndex: SerializedIndex;
    try {
      serializedIndex = JSON.parse(indexRaw) as SerializedIndex;
    } catch {
      throw new Error("QueryEngine: .uiq/index.json is corrupt. Run 'uiquarter init' to rebuild.");
    }

    let serializedInsights: SerializedInsights;
    try {
      serializedInsights = JSON.parse(insightsRaw) as SerializedInsights;
    } catch {
      throw new Error("QueryEngine: .uiq/insights.json is corrupt. Run 'uiquarter init' to rebuild.");
    }

    this.validateIndex(serializedIndex);
    this.validateInsights(serializedInsights);

    this.index = this.deserializeIndex(serializedIndex);
    this.insights = this.deserializeInsights(serializedInsights);

    this.buildInternalIndexes();
  }

  // ---------------------------------------------------------------------------
  // Public query methods
  // ---------------------------------------------------------------------------

  findComponent(name: string): PatternResult | null {
    this.ensureLoaded();
    return this.patternsByName.get(name) ?? null;
  }

  findDependencies(componentName: string): PatternResult[] {
    this.ensureLoaded();
    const pattern = this.patternsByName.get(componentName);
    if (pattern === undefined) {
      return [];
    }
    const depIds = this.dependenciesMap.get(pattern.id);
    if (depIds === undefined) {
      return [];
    }
    return depIds
      .map((id) => this.patternsById.get(id))
      .filter(isNonNullable)
      .sort((a, b) => comparePatternId(a.id, b.id));
  }

  findDependents(componentName: string): PatternResult[] {
    this.ensureLoaded();
    const pattern = this.patternsByName.get(componentName);
    if (pattern === undefined) {
      return [];
    }
    const depIds = this.dependentsMap.get(pattern.id);
    if (depIds === undefined) {
      return [];
    }
    return depIds
      .map((id) => this.patternsById.get(id))
      .filter(isNonNullable)
      .sort((a, b) => comparePatternId(a.id, b.id));
  }

  findInsights(type: InsightType): Insight[] {
    this.ensureLoaded();
    return this.insights
      .filter((insight) => insight.category === type)
      .sort((a, b) =>
        (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
        (b.confidence - a.confidence) ||
        compare(a.id, b.id),
      );
  }

  findHubComponents(): Insight[] {
    return this.findInsights("hub-component");
  }

  findDeepChains(): Insight[] {
    return this.findInsights("deep-dependency-chain");
  }

  getStats(): {
    totalPatterns: number;
    totalInsights: number;
    totalComponents: number;
  } {
    this.ensureLoaded();
    let totalComponents = 0;
    for (const pattern of this.patternsById.values()) {
      if (COMPONENT_TYPES.has(pattern.type)) {
        totalComponents += 1;
      }
    }
    return {
      totalPatterns: this.patternsById.size,
      totalInsights: this.insights.length,
      totalComponents,
    };
  }

  /**
   * Find patterns matching the given token.
   */
  findPatternsByToken(token: string): readonly PatternId[] {
    this.ensureLoaded();
    return this.invertedIndex!.getPatternsForToken(token);
  }

  /**
   * Find patterns matching any of the given tokens (union).
   */
  findPatternsByTokens(tokens: readonly string[]): readonly PatternId[] {
    this.ensureLoaded();
    return this.invertedIndex!.getPatternsForTokens(tokens);
  }

  /**
   * Resolve a free-form task description to scored pattern matches
   * using tokenization, optional fuzzy matching, and synonym expansion.
   *
   * Results are scored (exact: 1.0, synonym: 0.5, fuzzy: 0.2 per token)
   * and sorted by score descending, then patternId ascending.
   *
   * When `options.debug` is true the returned matches include a `reasons`
   * array with per-token scoring detail.  When false (default), `reasons`
   * is an empty array to keep the output compact.
   */
  resolveTask(
    input: string,
    options?: { fuzzy?: boolean; synonyms?: boolean; debug?: boolean },
  ): readonly ScoredMatch[] {
    this.ensureLoaded();
    const matches = this.invertedIndex!.search(input, options);
    const scorer = new ResolverScorer();
    const scored = scorer.scoreMatches(matches);

    if (options?.debug === true) {
      return scored;
    }

    // Strip reasons when debug is not enabled
    return scored.map((s) => ({
      patternId: s.patternId,
      score: s.score,
      matchedTokens: s.matchedTokens,
      reasons: [],
    }));
  }

  // ---------------------------------------------------------------------------
  // Private: validation
  // ---------------------------------------------------------------------------

  private validateIndex(raw: SerializedIndex): void {
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof raw.buildNumber !== "number" ||
      typeof raw.compositeHash !== "string" ||
      raw.entries === null ||
      typeof raw.entries !== "object" ||
      !Array.isArray(raw.edges) ||
      raw.stats === null ||
      typeof raw.stats !== "object"
    ) {
      throw new Error("QueryEngine: index.json has invalid structure");
    }
  }

  private validateInsights(raw: SerializedInsights): void {
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof raw.version !== "string" ||
      !Array.isArray(raw.insights)
    ) {
      throw new Error("QueryEngine: insights.json has invalid structure");
    }
  }

  // ---------------------------------------------------------------------------
  // Private: deserialization
  // ---------------------------------------------------------------------------

  private deserializeIndex(raw: SerializedIndex): IntelligenceIndex {
    // entries: Record → sorted Map
    const entries = new Map<PatternId, PatternResult>();
    const entryKeys = Object.keys(raw.entries).sort(compare);
    for (const key of entryKeys) {
      const pattern = raw.entries[key] as PatternResult;
      entries.set(key as PatternId, normalizePattern(pattern));
    }

    // edges: deserialize and sort
    const edges: DependencyEdge[] = [];
    for (const rawEdge of raw.edges) {
      const edge = rawEdge as Record<string, unknown>;
      if (
        typeof edge["from"] === "string" &&
        typeof edge["to"] === "string" &&
        typeof edge["kind"] === "string"
      ) {
        edges.push({
          from: edge["from"] as PatternId,
          to: edge["to"] as PatternId,
          kind: edge["kind"] as DependencyEdge["kind"],
        });
      }
    }
    edges.sort((a, b) =>
      compare(a.from as string, b.from as string) ||
      compare(a.to as string, b.to as string) ||
      compare(a.kind, b.kind),
    );

    // fileIndex: Record → sorted Map
    const fileIndex = new Map<string, readonly PatternId[]>();
    const filePaths = Object.keys(raw.fileIndex).sort(compare);
    for (const path of filePaths) {
      const ids = (raw.fileIndex[path] ?? []).map((s) => s as PatternId);
      fileIndex.set(normalizePath(path), [...ids].sort((a, b) => comparePatternId(a, b)));
    }

    // typeIndex: Record → sorted Map
    const typeIndex = new Map<PatternType, readonly PatternId[]>();
    const types = Object.keys(raw.typeIndex).sort(compare);
    for (const type of types) {
      const ids = (raw.typeIndex[type] ?? []).map((s) => s as PatternId);
      typeIndex.set(type as PatternType, [...ids].sort((a, b) => comparePatternId(a, b)));
    }

    // stats
    const rawStats = raw.stats as Record<string, unknown>;
    const stats: IndexStats = {
      totalPatterns: typeof rawStats["totalPatterns"] === "number" ? rawStats["totalPatterns"] : entries.size,
      totalEdges: typeof rawStats["totalEdges"] === "number" ? rawStats["totalEdges"] : edges.length,
      totalFiles: typeof rawStats["totalFiles"] === "number" ? rawStats["totalFiles"] : fileIndex.size,
      byFramework: readStringNumberRecord(rawStats["byFramework"]),
      byType: readStringNumberRecord(rawStats["byType"]),
    };

    return {
      schemaVersion: raw.schemaVersion ?? 1,
      buildNumber: raw.buildNumber,
      compositeHash: raw.compositeHash as OutputHash,
      entries,
      edges,
      fileIndex,
      typeIndex,
      stats,
    };
  }

  private deserializeInsights(raw: SerializedInsights): readonly Insight[] {
    const insights: Insight[] = [];
    for (const rawInsight of raw.insights) {
      const r = rawInsight as Record<string, unknown>;
      if (
        typeof r["id"] !== "string" ||
        typeof r["category"] !== "string" ||
        typeof r["severity"] !== "string"
      ) {
        continue;
      }
      insights.push({
        id: r["id"] as string,
        category: r["category"] as InsightType,
        severity: r["severity"] as InsightSeverity,
        title: typeof r["title"] === "string" ? r["title"] : "",
        description: typeof r["description"] === "string" ? r["description"] : "",
        relatedPatterns: readPatternIdArray(r["relatedPatterns"]),
        confidence: typeof r["confidence"] === "number" ? r["confidence"] : 0,
        metadata: isRecord(r["metadata"]) ? r["metadata"] as Readonly<Record<string, unknown>> : {},
      });
    }
    return insights.sort((a, b) => compare(a.id, b.id));
  }

  // ---------------------------------------------------------------------------
  // Private: build internal indexes
  // ---------------------------------------------------------------------------

  private buildInternalIndexes(): void {
    const index = this.index!;

    // Build dep-to-component map (same logic as InsightEngine)
    const depToComponent = new Map<PatternId, PatternId>();
    const sortedIds = [...index.entries.keys()].sort((a, b) => comparePatternId(a, b));
    for (const id of sortedIds) {
      const pattern = index.entries.get(id);
      if (pattern === undefined) continue;
      const sourcePatternId = pattern.metadata["sourcePatternId"];
      if (typeof sourcePatternId === "string") {
        depToComponent.set(id, sourcePatternId as PatternId);
      }
    }

    // Build patternsById (component-level only, excluding dep patterns)
    this.patternsById = new Map<PatternId, PatternResult>();
    for (const id of sortedIds) {
      if (depToComponent.has(id)) continue;
      const pattern = index.entries.get(id)!;
      this.patternsById.set(id, pattern);
    }

    // Build patternsByName (deterministic: sorted by filePath then id)
    const byName = new Map<string, PatternResult[]>();
    for (const [id, pattern] of this.patternsById) {
      const existing = byName.get(pattern.name);
      if (existing === undefined) {
        byName.set(pattern.name, [pattern]);
      } else {
        existing.push(pattern);
      }
      void id;
    }
    this.patternsByName = new Map<string, PatternResult>();
    const nameKeys = [...byName.keys()].sort(compare);
    for (const name of nameKeys) {
      const candidates = byName.get(name)!;
      candidates.sort((a, b) =>
        compare(a.filePath, b.filePath) || comparePatternId(a.id, b.id),
      );
      this.patternsByName.set(name, candidates[0]!);
    }

    // Build dependency/dependent maps at component level
    const depsMap = new Map<PatternId, Set<string>>();
    const depsOfMap = new Map<PatternId, Set<string>>();

    for (const edge of index.edges) {
      const sourceComponent = depToComponent.get(edge.from) ?? edge.from;
      const targetComponent = depToComponent.get(edge.to) ?? edge.to;

      if (sourceComponent === targetComponent) continue;

      // dependencies: source → targets
      let depSet = depsMap.get(sourceComponent);
      if (depSet === undefined) {
        depSet = new Set();
        depsMap.set(sourceComponent, depSet);
      }
      depSet.add(targetComponent as string);

      // dependents: target → sources
      let depOfSet = depsOfMap.get(targetComponent);
      if (depOfSet === undefined) {
        depOfSet = new Set();
        depsOfMap.set(targetComponent, depOfSet);
      }
      depOfSet.add(sourceComponent as string);
    }

    // Convert to sorted PatternId arrays
    this.dependenciesMap = new Map<PatternId, PatternId[]>();
    const depKeys = [...depsMap.keys()].sort((a, b) => comparePatternId(a, b));
    for (const key of depKeys) {
      const values = [...depsMap.get(key)!].sort(compare).map((s) => s as PatternId);
      this.dependenciesMap.set(key, values);
    }

    this.dependentsMap = new Map<PatternId, PatternId[]>();
    const depOfKeys = [...depsOfMap.keys()].sort((a, b) => comparePatternId(a, b));
    for (const key of depOfKeys) {
      const values = [...depsOfMap.get(key)!].sort(compare).map((s) => s as PatternId);
      this.dependentsMap.set(key, values);
    }

    // Build inverted index over all component-level patterns
    this.invertedIndex = new InvertedIndex([...this.patternsById.values()]);
  }

  // ---------------------------------------------------------------------------
  // Private: guard
  // ---------------------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.index === null) {
      throw new Error("QueryEngine: not loaded — call load() first");
    }
  }
}

// -----------------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------------

function comparePatternId(a: PatternId, b: PatternId): number {
  return compare(a as string, b as string);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizePattern(pattern: PatternResult): PatternResult {
  return {
    ...pattern,
    filePath: normalizePath(pattern.filePath),
    location: {
      ...pattern.location,
      file: normalizePath(pattern.location.file),
    },
  };
}

function readPatternIdArray(value: unknown): readonly PatternId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: PatternId[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push(item as PatternId);
    }
  }
  return result;
}

function readStringNumberRecord(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  const keys = Object.keys(raw).sort(compare);
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      result[key] = v;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNullable<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
