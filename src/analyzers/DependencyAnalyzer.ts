import { createHash } from "node:crypto";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerId,
  AnalyzerOutput,
  DiscoveredFile,
  PatternId,
  PatternResult,
} from "../types/index.js";
import { compare, stableStringify } from "../core/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPENDENCY_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "vue", "svelte",
]);

const KNOWN_LIBRARY_WRAPPERS = new Set([
  "memo", "forwardRef", "observer", "connect", "withRouter",
]);

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type EdgeKind = "render" | "hook-usage" | "hoc-wrapping" | "provider";

interface SemanticEdge {
  readonly from: PatternId;
  readonly to: PatternId;
  readonly kind: EdgeKind;
  readonly fromFile: string;
  readonly toFile: string;
  readonly confidence: number;
}

interface ComponentIndex {
  readonly patterns: readonly PatternResult[];
  readonly byId: ReadonlyMap<PatternId, PatternResult>;
  readonly byFile: ReadonlyMap<string, readonly PatternResult[]>;
  readonly hooksByName: ReadonlyMap<string, PatternResult>;
  readonly providersByContext: ReadonlyMap<string, PatternResult>;
  readonly available: boolean;
}

interface ImportIndex {
  readonly byFile: ReadonlyMap<string, PatternResult>;
  readonly available: boolean;
}

interface ResolvedBinding {
  readonly localName: string;
  readonly importedName: string;
  readonly kind: "default" | "named" | "namespace" | "side-effect";
  readonly resolvedPath: string;
  readonly sourceFile: string;
}

interface ImportBindingIndex {
  readonly bySourceFile: ReadonlyMap<string, readonly ResolvedBinding[]>;
}

interface GraphMetrics {
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly edgesByKind: Readonly<Record<EdgeKind, number>>;
  readonly maxInDegree: number;
  readonly maxOutDegree: number;
  readonly maxInDegreeNode: PatternId | null;
  readonly maxOutDegreeNode: PatternId | null;
  readonly orphanCount: number;
  readonly orphanNodes: readonly PatternId[];
  readonly cycleCount: number;
  readonly maxCycleLength: number;
  readonly averageOutDegree: number;
  readonly maxDepth: number;
  readonly componentCount: number;
}

// ---------------------------------------------------------------------------
// DependencyAnalyzer
// ---------------------------------------------------------------------------

export class DependencyAnalyzer implements Analyzer {
  readonly name = "dependency";
  readonly version = "1.0.0";
  readonly capabilities = [
    "semantic-dependency-graph",
    "hook-usage-tracking",
    "provider-consumer-linking",
    "hoc-wrapping-detection",
    "cycle-detection",
    "graph-metrics",
  ] as const;
  readonly dependencies = ["component", "import"] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return DEPENDENCY_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const startedAt = Date.now();
    const diagnostics: AnalyzerDiagnostic[] = [];

    // ── Phase 1: Index building ───────────────────────────────────────────
    const componentIndex = this.buildComponentIndex(context, diagnostics);
    const importIndex = this.buildImportIndex(context, diagnostics);

    if (!componentIndex.available) {
      return this.buildEmptyOutput(
        startedAt, diagnostics, importIndex.available, context.files.length,
      );
    }

    const importBindingIndex = this.buildImportBindingIndex(importIndex);

    // ── Phase 2: Edge detection ───────────────────────────────────────────
    if (context.signal?.aborted === true) {
      return this.buildEmptyOutput(
        startedAt, diagnostics, importIndex.available, context.files.length,
      );
    }

    const allEdges: SemanticEdge[] = [];

    allEdges.push(...this.detectRenderEdges(componentIndex));

    if (importIndex.available) {
      allEdges.push(...this.detectHookUsageEdges(componentIndex, importBindingIndex));
      allEdges.push(...this.detectHocWrappingEdges(componentIndex, importBindingIndex));
      allEdges.push(...this.detectProviderEdges(componentIndex, importBindingIndex));
    }

    const deduped = deduplicateEdges(allEdges);

    // ── Phase 3: Graph analysis ───────────────────────────────────────────
    const adjacency = buildAdjacencyList(deduped, componentIndex);
    const cycles = tarjanSCC(adjacency);
    const metrics = computeGraphMetrics(adjacency, componentIndex, deduped, cycles);

    // Emit cycle diagnostics
    for (const cycle of cycles) {
      const names = cycle.map(
        id => componentIndex.byId.get(id)?.name ?? (id as string),
      );
      if (cycle.length > 5) {
        diagnostics.push({
          severity: "warning",
          filePath: ".",
          message: `DEP006 Large dependency cycle detected (${cycle.length} members): ${names.join(" \u2192 ")}`,
          line: 1,
          column: 0,
        });
      } else {
        diagnostics.push({
          severity: "info",
          filePath: ".",
          message: `DEP003 Dependency cycle detected: ${names.join(" \u2192 ")} \u2192 ${names[0]}`,
          line: 1,
          column: 0,
        });
      }
    }

    // Emit hub diagnostic
    if (metrics.maxOutDegreeNode !== null && metrics.maxOutDegree > 10) {
      const hubPattern = componentIndex.byId.get(metrics.maxOutDegreeNode);
      diagnostics.push({
        severity: "info",
        filePath: hubPattern?.filePath ?? ".",
        message: `DEP004 Hub component "${hubPattern?.name ?? ""}" has ${metrics.maxOutDegree} outgoing dependencies`,
        line: hubPattern?.location.start.line ?? 1,
        column: hubPattern?.location.start.column ?? 0,
      });
    }

    // Emit orphan diagnostics
    for (const orphanId of metrics.orphanNodes) {
      const pattern = componentIndex.byId.get(orphanId);
      if (pattern !== undefined) {
        diagnostics.push({
          severity: "info",
          filePath: pattern.filePath,
          message: `DEP005 Orphan component "${pattern.name}" has no semantic dependencies`,
          line: pattern.location.start.line,
          column: pattern.location.start.column,
        });
      }
    }

    // ── Phase 4: Output construction ──────────────────────────────────────
    const patterns: PatternResult[] = [];

    // Group edges by source and target
    const edgesBySource = groupEdgesByField(deduped, "from");
    const edgesByTarget = groupEdgesByField(deduped, "to");

    // Nodes in cycles
    const nodesInCycles = new Set<PatternId>();
    for (const cycle of cycles) {
      for (const id of cycle) nodesInCycles.add(id);
    }

    // Participating nodes (have at least one edge)
    const participatingNodes = new Set<PatternId>();
    for (const edge of deduped) {
      participatingNodes.add(edge.from);
      participatingNodes.add(edge.to);
    }

    // Build dependency-node patterns
    const crossRefScore =
      (componentIndex.available ? 0.5 : 0) + (importIndex.available ? 0.5 : 0);

    for (const id of [...participatingNodes].sort(compareId)) {
      const sourcePattern = componentIndex.byId.get(id);
      if (sourcePattern === undefined) continue;

      const outEdges = sortEdges(edgesBySource.get(id) ?? []);
      const inEdges = edgesByTarget.get(id) ?? [];
      const depIds = uniqueSortedIds(outEdges.map(e => e.to));

      const renderCount = countEdgesOfKind(outEdges, "render");
      const hookCount = countEdgesOfKind(outEdges, "hook-usage");
      const hocCount = countEdgesOfKind(outEdges, "hoc-wrapping");
      const providerCount = countEdgesOfKind(outEdges, "provider");

      const avgConf = outEdges.length > 0
        ? outEdges.reduce((s, e) => s + e.confidence, 0) / outEdges.length
        : 0;
      const edgeCountScore = Math.min(1.0, outEdges.length / 5);
      const confidenceValue = (edgeCountScore * 0.4) + (avgConf * 0.4) + (crossRefScore * 0.2);

      patterns.push({
        id: `${sourcePattern.filePath}:${sourcePattern.name}:dep:1` as PatternId,
        type: sourcePattern.type,
        name: `${sourcePattern.name}:dependencies`,
        filePath: sourcePattern.filePath,
        location: sourcePattern.location,
        confidence: {
          value: round3(confidenceValue),
          source: "dependency-analysis",
          factors: [
            { name: "edge-count", weight: 0.4, score: round3(edgeCountScore) },
            { name: "edge-confidence", weight: 0.4, score: round3(avgConf) },
            { name: "cross-reference-quality", weight: 0.2, score: crossRefScore },
          ],
        },
        framework: sourcePattern.framework,
        dependencies: depIds,
        properties: {},
        metadata: {
          sourcePatternId: sourcePattern.id,
          edges: outEdges.map(e => ({
            target: e.to,
            kind: e.kind,
            targetName: componentIndex.byId.get(e.to)?.name ?? "",
            targetFile: e.toFile,
            confidence: e.confidence,
          })),
          renderDependencyCount: renderCount,
          hookUsageCount: hookCount,
          hocWrappingCount: hocCount,
          providerCount,
          totalEdgeCount: outEdges.length,
          inDegree: inEdges.length,
          outDegree: outEdges.length,
          isInCycle: nodesInCycles.has(id),
        },
      });
    }

    // Build graph pattern
    const graphConfidence =
      ((componentIndex.available ? 1.0 : 0.0) * 0.5) +
      ((importIndex.available ? 1.0 : 0.0) * 0.3) +
      (Math.min(1.0, metrics.totalNodes / 10) * 0.2);

    patterns.push({
      id: ".:dependency-graph:1" as PatternId,
      type: "utility",
      name: "dependency-graph",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: round3(graphConfidence),
        source: "dependency-analysis",
        factors: [
          { name: "component-analyzer-available", weight: 0.5, score: componentIndex.available ? 1.0 : 0.0 },
          { name: "import-analyzer-available", weight: 0.3, score: importIndex.available ? 1.0 : 0.0 },
          { name: "sample-size", weight: 0.2, score: round3(Math.min(1.0, metrics.totalNodes / 10)) },
        ],
      },
      framework: "unknown",
      dependencies: [],
      properties: {},
      metadata: {
        totalNodes: metrics.totalNodes,
        totalEdges: metrics.totalEdges,
        edgesByKind: metrics.edgesByKind,
        maxInDegree: metrics.maxInDegree,
        maxOutDegree: metrics.maxOutDegree,
        maxInDegreeNode: metrics.maxInDegreeNode,
        maxOutDegreeNode: metrics.maxOutDegreeNode,
        orphanCount: metrics.orphanCount,
        orphanNodes: metrics.orphanNodes,
        cycleCount: metrics.cycleCount,
        maxCycleLength: metrics.maxCycleLength,
        averageOutDegree: metrics.averageOutDegree,
        maxDepth: metrics.maxDepth,
        componentCount: metrics.componentCount,
      },
    });

    // Build cycle patterns
    for (let i = 0; i < cycles.length; i++) {
      const cycle = cycles[i]!;
      const memberNames = cycle.map(
        id => componentIndex.byId.get(id)?.name ?? (id as string),
      );

      // Find edge kinds within cycle
      const edgeKinds: string[] = [];
      for (let j = 0; j < cycle.length; j++) {
        const from = cycle[j]!;
        const to = cycle[(j + 1) % cycle.length]!;
        const edge = deduped.find(e => e.from === from && e.to === to);
        edgeKinds.push(edge?.kind ?? "unknown");
      }

      patterns.push({
        id: `.:dependency-cycle:${i + 1}` as PatternId,
        type: "utility",
        name: "dependency-cycle",
        filePath: ".",
        location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: 1.0,
          source: "dependency-analysis",
          factors: [{ name: "scc-detection", weight: 1.0, score: 1.0 }],
        },
        framework: "unknown",
        dependencies: [...cycle],
        properties: {},
        metadata: {
          cycleIndex: i + 1,
          members: [...cycle],
          memberNames,
          length: cycle.length,
          edgeKinds,
          severity: cycle.length > 5 ? "warning" : "info",
        },
      });
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    patterns.sort((a, b) => compare(a.id as string, b.id as string));
    diagnostics.sort((a, b) =>
      compare(a.filePath, b.filePath) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      compare(a.severity, b.severity) ||
      compare(a.message, b.message));

    const hash = createHash("sha256")
      .update(stableStringify({ patterns, diagnostics }))
      .digest("hex");

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash: hash as AnalyzerOutput["hash"],
      duration: Date.now() - startedAt,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: componentIndex.patterns.length,
        cacheHits: 0,
        cacheMisses: componentIndex.patterns.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Index building
  // -----------------------------------------------------------------------

  private buildComponentIndex(
    context: AnalyzerContext,
    diagnostics: AnalyzerDiagnostic[],
  ): ComponentIndex {
    const output = context.dependencyOutputs.get("component");
    if (output === undefined) {
      diagnostics.push({
        severity: "warning",
        filePath: ".",
        message: "DEP001 ComponentAnalyzer output not available; dependency analysis skipped",
        line: 1,
        column: 0,
      });
      return emptyComponentIndex();
    }

    const sorted = [...output.patterns].sort((a, b) =>
      compare(a.id as string, b.id as string));

    const byId = new Map<PatternId, PatternResult>();
    const byFile = new Map<string, PatternResult[]>();
    const hooksByName = new Map<string, PatternResult>();
    const providersByContext = new Map<string, PatternResult>();

    for (const pattern of sorted) {
      byId.set(pattern.id, pattern);

      const fileList = byFile.get(pattern.filePath);
      if (fileList === undefined) {
        byFile.set(pattern.filePath, [pattern]);
      } else {
        fileList.push(pattern);
      }

      if (pattern.type === "hook" && !hooksByName.has(pattern.name)) {
        hooksByName.set(pattern.name, pattern);
      }

      if (pattern.type === "provider") {
        const ctx = pattern.metadata["contextName"];
        if (typeof ctx === "string" && !providersByContext.has(ctx)) {
          providersByContext.set(ctx, pattern);
        }
      }
    }

    return {
      patterns: sorted,
      byId,
      byFile,
      hooksByName,
      providersByContext,
      available: true,
    };
  }

  private buildImportIndex(
    context: AnalyzerContext,
    diagnostics: AnalyzerDiagnostic[],
  ): ImportIndex {
    const output = context.dependencyOutputs.get("import");
    if (output === undefined) {
      diagnostics.push({
        severity: "warning",
        filePath: ".",
        message: "DEP002 ImportAnalyzer output not available; hook-usage and provider detection limited",
        line: 1,
        column: 0,
      });
      return { byFile: new Map(), available: false };
    }

    const sorted = [...output.patterns].sort((a, b) =>
      compare(a.id as string, b.id as string));

    const byFile = new Map<string, PatternResult>();
    for (const pattern of sorted) {
      if (!byFile.has(pattern.filePath)) {
        byFile.set(pattern.filePath, pattern);
      }
    }

    return { byFile, available: true };
  }

  private buildImportBindingIndex(importIndex: ImportIndex): ImportBindingIndex {
    const bySourceFile = new Map<string, ResolvedBinding[]>();

    for (const [filePath, pattern] of importIndex.byFile) {
      const imports = pattern.metadata["imports"];
      if (!Array.isArray(imports)) continue;

      const bindings: ResolvedBinding[] = [];

      for (const importEntry of imports) {
        if (!isRecord(importEntry)) continue;
        const resolvedPath = importEntry["resolvedPath"];
        if (typeof resolvedPath !== "string") continue;
        const normalizedPath = normalizePath(resolvedPath);

        const symbols = importEntry["symbols"];
        if (!Array.isArray(symbols)) continue;

        for (const sym of symbols) {
          if (!isRecord(sym)) continue;
          const name = sym["name"];
          const alias = sym["alias"];
          const kind = sym["kind"];

          if (typeof name !== "string") continue;
          if (
            kind !== "default" &&
            kind !== "named" &&
            kind !== "namespace" &&
            kind !== "side-effect"
          ) continue;

          const localName = typeof alias === "string"
            ? alias
            : kind === "default"
              ? (name === "default" ? fileBaseName(normalizedPath) : name)
              : name;

          bindings.push({
            localName,
            importedName: name,
            kind,
            resolvedPath: normalizedPath,
            sourceFile: filePath,
          });
        }
      }

      bindings.sort((a, b) =>
        compare(a.localName, b.localName) ||
        compare(a.resolvedPath, b.resolvedPath));

      if (bindings.length > 0) {
        bySourceFile.set(filePath, bindings);
      }
    }

    return { bySourceFile };
  }

  // -----------------------------------------------------------------------
  // Edge detection
  // -----------------------------------------------------------------------

  private detectRenderEdges(componentIndex: ComponentIndex): SemanticEdge[] {
    const edges: SemanticEdge[] = [];

    for (const pattern of componentIndex.patterns) {
      if (pattern.type === "hook") continue;

      for (const depId of pattern.dependencies) {
        const target = componentIndex.byId.get(depId);
        if (target === undefined) continue;

        edges.push({
          from: pattern.id,
          to: depId,
          kind: "render",
          fromFile: pattern.filePath,
          toFile: target.filePath,
          confidence: 1.0,
        });
      }
    }

    return edges;
  }

  private detectHookUsageEdges(
    componentIndex: ComponentIndex,
    importBindingIndex: ImportBindingIndex,
  ): SemanticEdge[] {
    const edges: SemanticEdge[] = [];

    for (const pattern of componentIndex.patterns) {
      const bindings = importBindingIndex.bySourceFile.get(pattern.filePath);
      if (bindings === undefined) continue;

      for (const binding of bindings) {
        if (!isHookName(binding.localName)) continue;

        const targetPatterns = componentIndex.byFile.get(binding.resolvedPath);
        if (targetPatterns === undefined) continue;

        let hookMatch: PatternResult | undefined;

        if (binding.kind === "named") {
          hookMatch = targetPatterns.find(
            p => p.type === "hook" && p.name === binding.importedName,
          );
        } else if (binding.kind === "default") {
          hookMatch = targetPatterns.find(p => p.type === "hook");
        }

        // Fallback: if importedName is "default", try any hook in file
        if (hookMatch === undefined && binding.importedName === "default") {
          hookMatch = targetPatterns.find(p => p.type === "hook");
        }

        if (hookMatch !== undefined && hookMatch.id !== pattern.id) {
          edges.push({
            from: pattern.id,
            to: hookMatch.id,
            kind: "hook-usage",
            fromFile: pattern.filePath,
            toFile: hookMatch.filePath,
            confidence: 0.85,
          });
        }
      }
    }

    return edges;
  }

  private detectHocWrappingEdges(
    componentIndex: ComponentIndex,
    importBindingIndex: ImportBindingIndex,
  ): SemanticEdge[] {
    const edges: SemanticEdge[] = [];

    for (const pattern of componentIndex.patterns) {
      const wrappers = pattern.metadata["wrappers"];
      if (!Array.isArray(wrappers)) continue;

      for (const wrapper of wrappers) {
        if (!isRecord(wrapper)) continue;
        const wrapperName = wrapper["wrapper"];
        if (typeof wrapperName !== "string") continue;
        if (KNOWN_LIBRARY_WRAPPERS.has(wrapperName)) continue;

        const bindings = importBindingIndex.bySourceFile.get(pattern.filePath);
        if (bindings === undefined) continue;

        const binding = bindings.find(b => b.localName === wrapperName);
        if (binding === undefined) continue;

        const targetPatterns = componentIndex.byFile.get(binding.resolvedPath);
        if (targetPatterns === undefined) continue;

        const hocMatch = targetPatterns.find(
          p => p.type === "hoc" && (
            p.name === binding.importedName || binding.kind === "default"
          ),
        );

        if (hocMatch !== undefined) {
          edges.push({
            from: hocMatch.id,
            to: pattern.id,
            kind: "hoc-wrapping",
            fromFile: hocMatch.filePath,
            toFile: pattern.filePath,
            confidence: 0.9,
          });
        }
      }
    }

    return edges;
  }

  private detectProviderEdges(
    componentIndex: ComponentIndex,
    importBindingIndex: ImportBindingIndex,
  ): SemanticEdge[] {
    const edges: SemanticEdge[] = [];

    for (const pattern of componentIndex.patterns) {
      if (pattern.type === "provider") continue;

      const bindings = importBindingIndex.bySourceFile.get(pattern.filePath);
      if (bindings === undefined) continue;

      for (const binding of bindings) {
        if (!binding.localName.endsWith("Context")) continue;

        const contextName = binding.localName.replace(/Context$/, "");
        const provider =
          componentIndex.providersByContext.get(contextName) ??
          componentIndex.providersByContext.get(binding.localName);

        if (provider !== undefined && provider.id !== pattern.id) {
          edges.push({
            from: pattern.id,
            to: provider.id,
            kind: "provider",
            fromFile: pattern.filePath,
            toFile: provider.filePath,
            confidence: 0.7,
          });
        }
      }
    }

    return edges;
  }

  // -----------------------------------------------------------------------
  // Empty output helper
  // -----------------------------------------------------------------------

  private buildEmptyOutput(
    startedAt: number,
    diagnostics: AnalyzerDiagnostic[],
    importAvailable: boolean,
    totalFiles: number,
  ): AnalyzerOutput {
    const graphPattern: PatternResult = {
      id: ".:dependency-graph:1" as PatternId,
      type: "utility",
      name: "dependency-graph",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: round3((importAvailable ? 1.0 : 0.0) * 0.3),
        source: "dependency-analysis",
        factors: [
          { name: "component-analyzer-available", weight: 0.5, score: 0.0 },
          { name: "import-analyzer-available", weight: 0.3, score: importAvailable ? 1.0 : 0.0 },
          { name: "sample-size", weight: 0.2, score: 0.0 },
        ],
      },
      framework: "unknown",
      dependencies: [],
      properties: {},
      metadata: {
        totalNodes: 0,
        totalEdges: 0,
        edgesByKind: { render: 0, "hook-usage": 0, "hoc-wrapping": 0, provider: 0 },
        maxInDegree: 0,
        maxOutDegree: 0,
        maxInDegreeNode: null,
        maxOutDegreeNode: null,
        orphanCount: 0,
        orphanNodes: [],
        cycleCount: 0,
        maxCycleLength: 0,
        averageOutDegree: 0,
        maxDepth: 0,
        componentCount: 0,
      },
    };

    const patterns = [graphPattern];

    diagnostics.sort((a, b) =>
      compare(a.filePath, b.filePath) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      compare(a.severity, b.severity) ||
      compare(a.message, b.message));

    const hash = createHash("sha256")
      .update(stableStringify({ patterns, diagnostics }))
      .digest("hex");

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash: hash as AnalyzerOutput["hash"],
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

// ---------------------------------------------------------------------------
// Graph algorithms
// ---------------------------------------------------------------------------

function buildAdjacencyList(
  edges: readonly SemanticEdge[],
  componentIndex: ComponentIndex,
): Map<PatternId, PatternId[]> {
  const adjacency = new Map<PatternId, PatternId[]>();

  for (const pattern of componentIndex.patterns) {
    adjacency.set(pattern.id, []);
  }

  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list !== undefined) {
      list.push(edge.to);
    }
  }

  for (const list of adjacency.values()) {
    list.sort(compareId);
  }

  return adjacency;
}

function tarjanSCC(adjacency: Map<PatternId, PatternId[]>): PatternId[][] {
  let counter = 0;
  const indices = new Map<PatternId, number>();
  const lowlinks = new Map<PatternId, number>();
  const onStack = new Set<PatternId>();
  const stack: PatternId[] = [];
  const sccs: PatternId[][] = [];

  const sortedNodes = [...adjacency.keys()].sort(compareId);

  const strongconnect = (v: PatternId): void => {
    indices.set(v, counter);
    lowlinks.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    const neighbors = adjacency.get(v) ?? [];
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: PatternId[] = [];
      let w: PatternId;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      if (scc.length > 1) {
        scc.sort(compareId);
        sccs.push(scc);
      } else if (scc.length === 1) {
        // Self-loop check
        const node = scc[0]!;
        const nodeNeighbors = adjacency.get(node) ?? [];
        if (nodeNeighbors.includes(node)) {
          sccs.push(scc);
        }
      }
    }
  };

  for (const v of sortedNodes) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
  }

  sccs.sort((a, b) => compareId(a[0] ?? ("" as PatternId), b[0] ?? ("" as PatternId)));
  return sccs;
}

function computeGraphMetrics(
  adjacency: Map<PatternId, PatternId[]>,
  componentIndex: ComponentIndex,
  edges: readonly SemanticEdge[],
  cycles: readonly PatternId[][],
): GraphMetrics {
  const totalNodes = componentIndex.patterns.length;
  const totalEdges = edges.length;

  const edgesByKind: Record<EdgeKind, number> = {
    render: 0, "hook-usage": 0, "hoc-wrapping": 0, provider: 0,
  };
  for (const edge of edges) {
    edgesByKind[edge.kind]++;
  }

  // Degree computation
  const outDegree = new Map<PatternId, number>();
  const inDegree = new Map<PatternId, number>();
  for (const pattern of componentIndex.patterns) {
    outDegree.set(pattern.id, 0);
    inDegree.set(pattern.id, 0);
  }
  for (const edge of edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  let maxInDegree = 0;
  let maxOutDegree = 0;
  let maxInDegreeNode: PatternId | null = null;
  let maxOutDegreeNode: PatternId | null = null;
  const orphanNodes: PatternId[] = [];

  // Iterate in deterministic order
  const sortedPatterns = [...componentIndex.patterns].sort((a, b) =>
    compare(a.id as string, b.id as string));

  for (const pattern of sortedPatterns) {
    const inD = inDegree.get(pattern.id) ?? 0;
    const outD = outDegree.get(pattern.id) ?? 0;

    if (inD > maxInDegree) {
      maxInDegree = inD;
      maxInDegreeNode = pattern.id;
    }
    if (outD > maxOutDegree) {
      maxOutDegree = outD;
      maxOutDegreeNode = pattern.id;
    }
    if (inD === 0 && outD === 0) {
      orphanNodes.push(pattern.id);
    }
  }

  orphanNodes.sort(compareId);

  const averageOutDegree = totalNodes > 0
    ? Math.round((totalEdges / totalNodes) * 100) / 100
    : 0;

  // Max depth via BFS from root nodes
  const maxDepth = bfsMaxDepth(adjacency, inDegree);

  // Weakly connected components
  const componentCount = countConnectedComponents(adjacency, edges);

  return {
    totalNodes,
    totalEdges,
    edgesByKind,
    maxInDegree,
    maxOutDegree,
    maxInDegreeNode,
    maxOutDegreeNode,
    orphanCount: orphanNodes.length,
    orphanNodes,
    cycleCount: cycles.length,
    maxCycleLength: cycles.reduce((max, c) => Math.max(max, c.length), 0),
    averageOutDegree,
    maxDepth,
    componentCount,
  };
}

function bfsMaxDepth(
  adjacency: Map<PatternId, PatternId[]>,
  inDegree: Map<PatternId, number>,
): number {
  const roots: PatternId[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0 && adjacency.has(id)) {
      roots.push(id);
    }
  }
  if (roots.length === 0) return 0;

  let maxDepth = 0;
  const visited = new Set<PatternId>();
  const queue: Array<{ id: PatternId; depth: number }> = [];

  for (const root of roots.sort(compareId)) {
    if (!visited.has(root)) {
      queue.push({ id: root, depth: 0 });
      visited.add(root);
    }
  }

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth > maxDepth) maxDepth = depth;

    const neighbors = adjacency.get(id) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
  }

  return maxDepth;
}

function countConnectedComponents(
  adjacency: Map<PatternId, PatternId[]>,
  edges: readonly SemanticEdge[],
): number {
  const parent = new Map<PatternId, PatternId>();
  const rank = new Map<PatternId, number>();

  for (const id of adjacency.keys()) {
    parent.set(id, id);
    rank.set(id, 0);
  }

  const find = (x: PatternId): PatternId => {
    let current = x;
    while (parent.get(current) !== current) {
      const p = parent.get(current)!;
      parent.set(current, parent.get(p)!);
      current = p;
    }
    return current;
  };

  const union = (x: PatternId, y: PatternId): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    const rankX = rank.get(rx) ?? 0;
    const rankY = rank.get(ry) ?? 0;
    if (rankX < rankY) {
      parent.set(rx, ry);
    } else if (rankX > rankY) {
      parent.set(ry, rx);
    } else {
      parent.set(ry, rx);
      rank.set(rx, rankX + 1);
    }
  };

  for (const edge of edges) {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
      union(edge.from, edge.to);
    }
  }

  const roots = new Set<PatternId>();
  for (const id of adjacency.keys()) {
    roots.add(find(id));
  }
  return roots.size;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyComponentIndex(): ComponentIndex {
  return {
    patterns: [],
    byId: new Map(),
    byFile: new Map(),
    hooksByName: new Map(),
    providersByContext: new Map(),
    available: false,
  };
}

function deduplicateEdges(edges: readonly SemanticEdge[]): SemanticEdge[] {
  const sorted = [...edges].sort((a, b) =>
    compare(a.from as string, b.from as string) ||
    compare(a.to as string, b.to as string) ||
    compare(a.kind, b.kind));

  const result: SemanticEdge[] = [];
  for (const edge of sorted) {
    const prev = result[result.length - 1];
    if (
      prev !== undefined &&
      prev.from === edge.from &&
      prev.to === edge.to &&
      prev.kind === edge.kind
    ) {
      continue;
    }
    result.push(edge);
  }
  return result;
}

function groupEdgesByField(
  edges: readonly SemanticEdge[],
  field: "from" | "to",
): Map<PatternId, SemanticEdge[]> {
  const map = new Map<PatternId, SemanticEdge[]>();
  for (const edge of edges) {
    const key = edge[field];
    const list = map.get(key);
    if (list === undefined) {
      map.set(key, [edge]);
    } else {
      list.push(edge);
    }
  }
  return map;
}

function sortEdges(edges: readonly SemanticEdge[]): SemanticEdge[] {
  return [...edges].sort((a, b) =>
    compare(a.to as string, b.to as string) || compare(a.kind, b.kind));
}

function countEdgesOfKind(edges: readonly SemanticEdge[], kind: EdgeKind): number {
  let count = 0;
  for (const edge of edges) {
    if (edge.kind === kind) count++;
  }
  return count;
}

function uniqueSortedIds(ids: readonly PatternId[]): PatternId[] {
  return [...new Set(ids)].sort(compareId);
}

function compareId(a: PatternId, b: PatternId): number {
  return compare(a as string, b as string);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

function normalizePath(value: string): string {
  const result = value.replace(/\\/g, "/");
  return result.startsWith("./") ? result.slice(2) : result;
}

function fileBaseName(filePath: string): string {
  const normalized = normalizePath(filePath);
  const name = normalized.split("/").pop() ?? normalized;
  const dotIndex = name.lastIndexOf(".");
  return dotIndex === -1 ? name : name.slice(0, dotIndex);
}
