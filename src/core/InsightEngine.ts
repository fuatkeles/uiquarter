import { createHash } from "node:crypto";
import { compare, stableStringify } from "./utils.js";
import type {
  DependencyEdge,
  IntelligenceIndex,
  PatternId,
  PatternResult,
  PatternType,
} from "../types/index.js";
import type {
  Insight,
  InsightEngineResult,
  InsightSeverity,
  InsightType,
} from "../types/insight.js";

type SemanticEdgeKind = Extract<
  DependencyEdge["kind"],
  "render" | "hook-usage" | "hoc-wrapping" | "provider"
>;

interface InsightEngineConfig {
  readonly hubInDegreeThreshold: number;
  readonly hubPercentileThreshold: number;
  readonly orphanExcludeTypes: readonly PatternType[];
  readonly orphanExcludeRoles: readonly string[];
  readonly deepChainThreshold: number;
  readonly mixedStylingMinTechnologies: number;
  readonly mixedStylingFileThreshold: number;
  readonly godComponentOutDegree: number;
  readonly excessivePropCount: number;
  readonly missingBarrelMinExports: number;
  readonly maxInsightsPerCategory: number;
}

interface AdjacencyMaps {
  readonly outgoing: ReadonlyMap<PatternId, readonly DependencyEdge[]>;
  readonly incoming: ReadonlyMap<PatternId, readonly DependencyEdge[]>;
  readonly inDegree: ReadonlyMap<PatternId, number>;
  readonly outDegree: ReadonlyMap<PatternId, number>;
  readonly renderInDegree: ReadonlyMap<PatternId, number>;
}

interface EdgeConfidenceLookup {
  readonly bySource: ReadonlyMap<PatternId, ReadonlyMap<string, number>>;
}

interface DeepChainCandidate {
  readonly root: PatternId;
  readonly leaf: PatternId;
  readonly depth: number;
  readonly chain: readonly PatternId[];
  readonly edges: readonly DependencyEdge[];
}

const DEFAULT_CONFIG: InsightEngineConfig = {
  hubInDegreeThreshold: 5,
  hubPercentileThreshold: 0.9,
  orphanExcludeTypes: ["page", "layout", "provider"],
  orphanExcludeRoles: ["pages", "layouts", "root"],
  deepChainThreshold: 8,
  mixedStylingMinTechnologies: 3,
  mixedStylingFileThreshold: 2,
  godComponentOutDegree: 10,
  excessivePropCount: 15,
  missingBarrelMinExports: 3,
  maxInsightsPerCategory: 50,
};

const COMPONENT_LIKE_TYPES = new Set<PatternType>([
  "component",
  "hook",
  "hoc",
  "provider",
]);

const ORPHAN_CANDIDATE_TYPES: readonly PatternType[] = [
  "component",
  "hook",
  "hoc",
];

const NON_COMPONENT_DIRECTORY_ROLES = new Set([
  "utils",
  "helpers",
  "lib",
  "services",
  "api",
  "constants",
  "types",
  "models",
]);

const STYLING_FLAGS = [
  "tailwind",
  "styled-components",
  "emotion",
  "vanilla-extract",
  "css-modules",
  "inline-styles",
] as const;

const INFRA_UTILITY_NAMES = new Set([
  "module",
  "stylesheet",
  "styling",
  "directory",
  "conventions",
  "dependency-graph",
  "dependency-cycle",
  "styling-profile",
]);

const SEMANTIC_EDGE_KINDS = new Set<SemanticEdgeKind>([
  "render",
  "hook-usage",
  "hoc-wrapping",
  "provider",
]);

const SEVERITY_ORDER: Record<InsightSeverity, number> = { error: 0, warning: 1, info: 2 };

export class InsightEngine {
  private readonly config: InsightEngineConfig;

  constructor(config?: Partial<InsightEngineConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...(config ?? {}),
      orphanExcludeTypes: [...(config?.orphanExcludeTypes ?? DEFAULT_CONFIG.orphanExcludeTypes)],
      orphanExcludeRoles: [...(config?.orphanExcludeRoles ?? DEFAULT_CONFIG.orphanExcludeRoles)],
    };
  }

  generate(
    index: IntelligenceIndex,
    options?: { signal?: AbortSignal },
  ): InsightEngineResult {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new Error("InsightEngine aborted");
    }
    const start = performance.now();
    const depToComponent = this.buildDepToComponentMap(index);
    const adjacency = this.buildAdjacencyMaps(index.edges, depToComponent);
    const edgeConfidence = this.buildEdgeConfidenceLookup(index, depToComponent);
    const directoryPatterns = this.collectDirectoryPatterns(index);
    const barrelExposure = this.collectBarrelExposure(index);

    const byCategory: Insight[] = [];
    byCategory.push(
      ...this.detectHubComponents(index, adjacency, edgeConfidence, depToComponent, signal),
      ...this.detectOrphanComponents(index, adjacency, directoryPatterns, barrelExposure, depToComponent, signal),
      ...this.detectDependencyCycles(index),
      ...this.detectDeepDependencyChains(index, edgeConfidence, depToComponent, signal),
      ...this.detectMixedStyling(index),
      ...this.detectArchitecturalSmells(index, adjacency, directoryPatterns, depToComponent),
    );

    const sorted = [...byCategory].sort((a, b) => compare(a.id, b.id));
    const deduped: Insight[] = [];
    let previousId: string | null = null;
    for (const insight of sorted) {
      if (previousId === insight.id) continue;
      deduped.push(insight);
      previousId = insight.id;
    }

    const hash = this.computeInsightsHash(deduped);
    if (hash.length !== 64) {
      throw new Error("InsightEngine hash computation failed");
    }

    const byTypeCounts: Record<string, number> = {};
    for (const insight of deduped) {
      const key = insight.category;
      byTypeCounts[key] = (byTypeCounts[key] ?? 0) + 1;
    }

    const byType: Record<string, number> = {};
    for (const key of Object.keys(byTypeCounts).sort(compare)) {
      byType[key] = byTypeCounts[key]!;
    }

    const durationMs = Math.round(performance.now() - start);

    return {
      insights: deduped,
      hash,
      durationMs,
      stats: {
        total: deduped.length,
        byType,
      },
    };
  }

  private detectHubComponents(
    index: IntelligenceIndex,
    adjacency: AdjacencyMaps,
    edgeConfidence: EdgeConfidenceLookup,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
    signal?: AbortSignal,
  ): Insight[] {
    const degrees = [...adjacency.renderInDegree.values()].sort((a, b) => a - b);
    if (degrees.length === 0) {
      return [];
    }

    const percentileIndex = Math.floor(degrees.length * this.config.hubPercentileThreshold);
    const percentileValue = degrees[Math.min(percentileIndex, degrees.length - 1)] ?? 0;
    const effectiveThreshold = Math.max(this.config.hubInDegreeThreshold, percentileValue);

    const insights: Insight[] = [];
    const sortedPatternIds = [...adjacency.renderInDegree.keys()].sort(comparePatternId);
    if (signal?.aborted) {
      throw new Error("InsightEngine aborted");
    }
    for (const patternId of sortedPatternIds) {
      if (signal?.aborted) {
        throw new Error("InsightEngine aborted");
      }
      const renderInDegree = adjacency.renderInDegree.get(patternId) ?? 0;
      if (renderInDegree < effectiveThreshold) {
        continue;
      }

      const pattern = index.entries.get(patternId);
      if (pattern === undefined || !COMPONENT_LIKE_TYPES.has(pattern.type)) {
        continue;
      }

      const incoming = adjacency.incoming.get(patternId) ?? [];
      const renderIncoming = incoming.filter((edge) => edge.kind === "render");
      const dependents = uniquePatternIds(
        renderIncoming
          .map((edge) => this.resolveComponentId(edge.from, depToComponent))
          .filter((id) => index.entries.has(id)),
      ).sort(comparePatternId);

      const dependentNames = uniqueSortedStrings(
        dependents.map((id) => index.entries.get(id)?.name).filter(isNonNullable),
      );
      const dependentFiles = uniqueSortedStrings(
        dependents.map((id) => index.entries.get(id)?.filePath).filter(isNonNullable),
      );

      const totalInDegree = adjacency.inDegree.get(patternId) ?? 0;
      const hookUsageInDegree = incoming.filter((edge) => edge.kind === "hook-usage").length;
      const avgEdgeConfidence = renderIncoming.length === 0
        ? 0.7
        : renderIncoming.reduce((sum, edge) => (
          sum + this.lookupEdgeConfidence(edge, edgeConfidence, depToComponent, 0.7)
        ), 0) / renderIncoming.length;

      const magnitudeDenominator = Math.max(1, 3 * effectiveThreshold);
      const magnitudeScore = Math.min(1, renderInDegree / magnitudeDenominator);
      const confidence = this.normalizeConfidence((magnitudeScore * 0.6) + (avgEdgeConfidence * 0.4));

      let severity: InsightSeverity = "info";
      if (renderInDegree >= 3 * effectiveThreshold) {
        severity = "error";
      } else if (renderInDegree >= 2 * effectiveThreshold) {
        severity = "warning";
      }

      const percentile = this.normalizeConfidence(percentileOfDegree(degrees, renderInDegree));
      const relatedPatterns = this.filterExistingOrdered(index, [
        patternId,
        ...dependents,
      ]);

      insights.push({
        id: this.buildInsightId("hub-component", patternId as string),
        category: "hub-component",
        severity,
        title: `Hub component: ${pattern.name} (${renderInDegree} dependents)`,
        description: `${pattern.name} in ${pattern.filePath} is rendered by ${renderInDegree} other components. Changes to this component affect ${renderInDegree} dependents. Consider if this coupling is intentional or if the component should be split.`,
        relatedPatterns,
        confidence,
        metadata: {
          renderInDegree,
          totalInDegree,
          dependents,
          dependentNames,
          dependentFiles,
          hookUsageInDegree,
          percentile,
        },
      });
    }

    return this.applyCategoryLimit(insights);
  }

  private detectOrphanComponents(
    index: IntelligenceIndex,
    adjacency: AdjacencyMaps,
    directoryPatterns: ReadonlyMap<string, PatternResult>,
    barrelExposure: ReadonlySet<string>,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
    signal?: AbortSignal,
  ): Insight[] {
    const candidateIds = uniquePatternIds(
      ORPHAN_CANDIDATE_TYPES.flatMap((type) => this.getTypeIds(index, type, depToComponent)),
    ).sort(comparePatternId);

    const insights: Insight[] = [];
    if (signal?.aborted) {
      throw new Error("InsightEngine aborted");
    }
    for (const patternId of candidateIds) {
      if (signal?.aborted) {
        throw new Error("InsightEngine aborted");
      }
      const pattern = index.entries.get(patternId);
      if (pattern === undefined) {
        continue;
      }

      const renderInDegree = adjacency.renderInDegree.get(patternId) ?? 0;
      if (renderInDegree > 0) {
        continue;
      }

      if (this.config.orphanExcludeTypes.includes(pattern.type)) {
        continue;
      }

      if (this.isPageOrEntryComponent(pattern, directoryPatterns)) {
        continue;
      }

      const outgoing = adjacency.outgoing.get(patternId) ?? [];
      const renderOutDegree = outgoing.filter((edge) => edge.kind === "render").length;
      const importInDegree = (adjacency.incoming.get(patternId) ?? [])
        .filter((edge) => edge.kind === "import")
        .length;
      const directoryRole = this.lookupDirectoryRole(directoryPatterns, pattern.filePath);
      const isDefaultExport = readBoolean(pattern.metadata["isDefaultExport"]) === true;
      const isNamedExport = readBoolean(pattern.metadata["isNamedExport"]) === true;
      const isExported = isDefaultExport || isNamedExport;
      const isInBarrel = barrelExposure.has(normalizePath(pattern.filePath));

      const noRenderEdgesScore = 1;
      const notPageScore = 1;
      const noBarrelExposure = isInBarrel ? 0.3 : 1;
      const hasImportEdges = importInDegree > 0 ? 0.5 : 1;
      const confidence = this.normalizeConfidence(
        (noRenderEdgesScore * 0.3) +
        (notPageScore * 0.3) +
        (noBarrelExposure * 0.2) +
        (hasImportEdges * 0.2),
      );

      const severity: InsightSeverity = renderOutDegree > 0 ? "warning" : "info";
      const descriptionSuffix = renderOutDegree > 0
        ? `It renders ${renderOutDegree} other components, suggesting it may be dead code.`
        : "It may be an entry point, library export, or unused component.";

      insights.push({
        id: this.buildInsightId("orphan-component", patternId as string),
        category: "orphan-component",
        severity,
        title: `Orphan component: ${pattern.name}`,
        description: `${pattern.name} in ${pattern.filePath} is never rendered by another component. ${descriptionSuffix}`,
        relatedPatterns: this.filterExistingOrdered(index, [patternId]),
        confidence,
        metadata: {
          outDegree: renderOutDegree,
          importInDegree,
          isExported,
          isInBarrel,
          directoryRole,
          exclusionReason: null,
        },
      });
    }

    return this.applyCategoryLimit(insights);
  }

  private detectDependencyCycles(index: IntelligenceIndex): Insight[] {
    const cyclePatterns = [...index.entries.values()]
      .filter((pattern) => pattern.name === "dependency-cycle")
      .sort((a, b) => (
        (readNumber(a.metadata["cycleIndex"]) ?? Number.MAX_SAFE_INTEGER) -
        (readNumber(b.metadata["cycleIndex"]) ?? Number.MAX_SAFE_INTEGER) ||
        compare(a.id as string, b.id as string)
      ));

    const insights: Insight[] = [];
    for (let i = 0; i < cyclePatterns.length; i += 1) {
      const pattern = cyclePatterns[i]!;
      const cycleIndex = readNumber(pattern.metadata["cycleIndex"]) ?? (i + 1);

      const orderedMembers = readPatternIdArray(pattern.metadata["members"]);
      const membersSorted = uniquePatternIds(orderedMembers).sort(comparePatternId);
      const memberNamesOrdered = readStringArrayOrdered(pattern.metadata["memberNames"]);
      const edgeKindsOrdered = readStringArrayOrdered(pattern.metadata["edgeKinds"]);

      const resolvedMemberNames = memberNamesOrdered.length > 0
        ? memberNamesOrdered
        : orderedMembers
          .map((memberId) => index.entries.get(memberId)?.name)
          .filter(isNonNullable);

      const resolvedMemberFiles = orderedMembers
        .map((memberId) => index.entries.get(memberId)?.filePath)
        .filter(isNonNullable);

      const length = readNumber(pattern.metadata["length"]) ?? orderedMembers.length;
      const uniqueEdgeKinds = uniqueSortedStrings(edgeKindsOrdered);

      let severity: InsightSeverity = "info";
      if (length > 5) {
        severity = "error";
      } else if (length > 2) {
        severity = "warning";
      }

      const titleMemberNames = resolvedMemberNames.length > 3
        ? [...resolvedMemberNames.slice(0, 3), "..."]
        : resolvedMemberNames;
      const titleStart = titleMemberNames[0] ?? "cycle";

      insights.push({
        id: this.buildInsightId("dependency-cycle", `cycle-${cycleIndex}`),
        category: "dependency-cycle",
        severity,
        title: `Dependency cycle: ${titleMemberNames.join(" -> ")} -> ${titleStart}`,
        description: `Circular dependency of ${length} components: ${resolvedMemberNames.join(" -> ")} -> ${resolvedMemberNames[0] ?? ""}. Edge kinds: ${uniqueEdgeKinds.join(", ")}. Circular dependencies make refactoring difficult and can cause initialization issues.`,
        relatedPatterns: this.filterExistingSorted(index, membersSorted),
        confidence: 1,
        metadata: {
          cycleIndex,
          length,
          members: membersSorted,
          memberNames: resolvedMemberNames,
          memberFiles: resolvedMemberFiles,
          edgeKinds: edgeKindsOrdered,
          uniqueEdgeKinds,
          sourceCyclePatternId: pattern.id,
        },
      });
    }

    return this.applyCategoryLimit(insights);
  }

  private detectDeepDependencyChains(
    index: IntelligenceIndex,
    edgeConfidence: EdgeConfidenceLookup,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
    signal?: AbortSignal,
  ): Insight[] {
    const semanticEdgeMap = new Map<string, DependencyEdge>();
    const sortedInputEdges = [...index.edges].sort(compareEdges);
    for (const edge of sortedInputEdges) {
      if (!SEMANTIC_EDGE_KINDS.has(edge.kind as SemanticEdgeKind)) {
        continue;
      }
      const fromComponent = this.resolveComponentId(edge.from, depToComponent);
      const toComponent = this.resolveComponentId(edge.to, depToComponent);
      const normalized: DependencyEdge = {
        from: fromComponent,
        to: toComponent,
        kind: edge.kind,
      };
      const key = `${normalized.from as string}|${normalized.to as string}|${normalized.kind}`;
      if (!semanticEdgeMap.has(key)) {
        semanticEdgeMap.set(key, normalized);
      }
    }
    const semanticEdges = [...semanticEdgeMap.values()].sort(compareEdges);

    if (semanticEdges.length === 0) {
      return [];
    }

    const outgoing = new Map<PatternId, DependencyEdge[]>();
    const inDegree = new Map<PatternId, number>();
    for (const edge of semanticEdges) {
      const out = outgoing.get(edge.from);
      if (out === undefined) {
        outgoing.set(edge.from, [edge]);
      } else {
        out.push(edge);
      }
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    const rootCandidates = uniquePatternIds([
      ...this.getTypeIds(index, "component", depToComponent),
      ...this.getTypeIds(index, "hook", depToComponent),
      ...this.getTypeIds(index, "hoc", depToComponent),
      ...this.getTypeIds(index, "provider", depToComponent),
    ])
      .filter((id) => (inDegree.get(id) ?? 0) === 0)
      .sort(comparePatternId);

    const memoDepth = new Map<PatternId, number>();
    const nextNode = new Map<PatternId, PatternId>();

    const longestFrom = (id: PatternId, visiting: Set<PatternId>): number => {
      const memoized = memoDepth.get(id);
      if (memoized !== undefined) {
        return memoized;
      }
      if (visiting.has(id)) {
        return 0;
      }

      visiting.add(id);
      const neighbors = uniquePatternIds(
        (outgoing.get(id) ?? []).map((edge) => edge.to),
      ).sort(comparePatternId);

      let maxChildDepth = 0;
      let bestNext: PatternId | null = null;
      for (const neighbor of neighbors) {
        const childDepth = longestFrom(neighbor, visiting) + 1;
        if (
          childDepth > maxChildDepth ||
          (childDepth === maxChildDepth && bestNext !== null && comparePatternId(neighbor, bestNext) < 0)
        ) {
          maxChildDepth = childDepth;
          bestNext = neighbor;
        } else if (childDepth === maxChildDepth && bestNext === null) {
          bestNext = neighbor;
        }
      }

      visiting.delete(id);
      memoDepth.set(id, maxChildDepth);
      if (bestNext !== null) {
        nextNode.set(id, bestNext);
      }
      return maxChildDepth;
    };

    if (signal?.aborted) {
      throw new Error("InsightEngine aborted");
    }
    for (const root of rootCandidates) {
      if (signal?.aborted) {
        throw new Error("InsightEngine aborted");
      }
      longestFrom(root, new Set<PatternId>());
    }

    const chains: DeepChainCandidate[] = [];
    if (signal?.aborted) {
      throw new Error("InsightEngine aborted");
    }
    for (const root of rootCandidates) {
      if (signal?.aborted) {
        throw new Error("InsightEngine aborted");
      }
      const depth = memoDepth.get(root) ?? 0;
      if (depth <= this.config.deepChainThreshold) {
        continue;
      }

      const chain: PatternId[] = [root];
      const seen = new Set<PatternId>([root]);
      let current = root;
      for (;;) {
        const next = nextNode.get(current);
        if (next === undefined || seen.has(next)) {
          break;
        }
        chain.push(next);
        seen.add(next);
        current = next;
      }

      const resolvedDepth = Math.max(0, chain.length - 1);
      if (resolvedDepth <= this.config.deepChainThreshold || chain.length < 2) {
        continue;
      }

      const edges: DependencyEdge[] = [];
      for (let i = 0; i < chain.length - 1; i += 1) {
        const from = chain[i]!;
        const to = chain[i + 1]!;
        const edge = (outgoing.get(from) ?? [])
          .filter((item) => item.to === to)
          .sort(compareEdges)[0];
        if (edge !== undefined) {
          edges.push(edge);
        }
      }

      const leaf = chain[chain.length - 1]!;
      chains.push({
        root,
        leaf,
        depth: resolvedDepth,
        chain,
        edges,
      });
    }

    const bestByLeaf = new Map<PatternId, DeepChainCandidate>();
    for (const chain of chains) {
      const existing = bestByLeaf.get(chain.leaf);
      if (
        existing === undefined ||
        chain.depth > existing.depth ||
        (chain.depth === existing.depth && comparePatternId(chain.root, existing.root) < 0)
      ) {
        bestByLeaf.set(chain.leaf, chain);
      }
    }

    const dedupedChains = [...bestByLeaf.values()]
      .sort((a, b) => (
        b.depth - a.depth ||
        comparePatternId(a.leaf, b.leaf)
      ));

    const insights: Insight[] = [];
    if (signal?.aborted) {
      throw new Error("InsightEngine aborted");
    }
    for (const chain of dedupedChains) {
      if (signal?.aborted) {
        throw new Error("InsightEngine aborted");
      }
      const rootPattern = index.entries.get(chain.root);
      const leafPattern = index.entries.get(chain.leaf);
      if (rootPattern === undefined || leafPattern === undefined) {
        continue;
      }

      const chainNames = chain.chain.map((id) => index.entries.get(id)?.name ?? (id as string));
      const chainFiles = chain.chain.map((id) => index.entries.get(id)?.filePath ?? "");
      const edgeKinds = chain.edges.map((edge) => edge.kind);

      const threshold = this.config.deepChainThreshold;
      const depthRatio = threshold <= 0
        ? 1
        : Math.min(1, ((chain.depth - threshold) / threshold) + 0.5);

      const edgeConfidences = chain.edges.map((edge) =>
        this.lookupEdgeConfidence(edge, edgeConfidence, depToComponent, 0.8));
      const chainEdgeConfidence = geometricMean(edgeConfidences, 0.8);
      const confidence = this.normalizeConfidence((depthRatio * 0.6) + (chainEdgeConfidence * 0.4));

      const severity: InsightSeverity = chain.depth > (2 * threshold) ? "error" : "warning";

      insights.push({
        id: this.buildInsightId("deep-dependency-chain", chain.leaf as string),
        category: "deep-dependency-chain",
        severity,
        title: `Deep dependency chain: ${chain.depth} levels (${rootPattern.name} -> ... -> ${leafPattern.name})`,
        description: `Dependency chain of ${chain.depth} levels from ${rootPattern.name} (${rootPattern.filePath}) to ${leafPattern.name} (${leafPattern.filePath}). This exceeds the threshold of ${threshold}. Deep chains increase coupling and make changes risky. Consider introducing abstraction boundaries.`,
        relatedPatterns: this.filterExistingOrdered(index, chain.chain),
        confidence,
        metadata: {
          depth: chain.depth,
          chain: chain.chain,
          chainNames,
          chainFiles,
          rootPatternId: chain.root,
          leafPatternId: chain.leaf,
          edgeKinds,
          threshold,
        },
      });
    }

    return this.applyCategoryLimit(insights);
  }

  private detectMixedStyling(index: IntelligenceIndex): Insight[] {
    const insights: Insight[] = [];
    const profilePattern = index.entries.get(".:styling-profile:1" as PatternId);

    if (profilePattern !== undefined) {
      const technologyTally = readNumberRecord(profilePattern.metadata["technologyTally"]);
      const activeTechnologies = Object.entries(technologyTally)
        .filter(([key, value]) => value > 0 && key !== "plain-css" && key !== "mixed")
        .map(([key]) => key)
        .sort(compare);

      const hasUtilityFirst = (technologyTally["tailwind"] ?? 0) > 0;
      const hasCssInJs = (technologyTally["styled-components"] ?? 0) > 0 ||
        (technologyTally["emotion"] ?? 0) > 0 ||
        (technologyTally["vanilla-extract"] ?? 0) > 0;
      const isParadigmClash = hasUtilityFirst && hasCssInJs;

      if (
        activeTechnologies.length >= this.config.mixedStylingMinTechnologies ||
        isParadigmClash
      ) {
        const primaryApproach = readString(profilePattern.metadata["primaryApproach"]) ?? "unknown";
        const primaryCount = technologyTally[primaryApproach] ?? 0;
        const totalStyleFiles = readNumber(profilePattern.metadata["totalStyleFiles"]) ?? 0;
        const totalStyledSourceFiles = readNumber(profilePattern.metadata["totalStyledSourceFiles"]) ?? 0;
        const totalFiles = totalStyleFiles + totalStyledSourceFiles;

        const tallyValues = Object.values(technologyTally).filter((value) => value > 0);
        const tallySum = tallyValues.reduce((sum, value) => sum + value, 0);
        const tallyMax = tallyValues.length === 0 ? 0 : Math.max(...tallyValues);
        const consistency = tallySum === 0 ? 0 : tallyMax / tallySum;
        const confidence = this.normalizeConfidence(
          Math.min(1, activeTechnologies.length / 5) * (1 - (consistency * 0.5)),
        );

        insights.push({
          id: this.buildInsightId("mixed-styling", "project"),
          category: "mixed-styling",
          severity: isParadigmClash ? "error" : "warning",
          title: `Mixed styling: ${activeTechnologies.length} approaches across project`,
          description: `Project uses ${activeTechnologies.join(", ")}. Primary approach: ${primaryApproach} (${primaryCount} files). Consolidating to fewer styling approaches reduces bundle size and cognitive overhead.`,
          relatedPatterns: this.filterExistingOrdered(index, [profilePattern.id]),
          confidence,
          metadata: {
            activeTechnologies,
            technologyTally,
            primaryApproach,
            totalFiles,
            isParadigmClash,
          },
        });
      }
    }

    const sortedPatternIds = [...index.entries.keys()].sort(comparePatternId);
    for (const patternId of sortedPatternIds) {
      const pattern = index.entries.get(patternId);
      if (pattern === undefined || pattern.name !== "styling") {
        continue;
      }

      const activeApproaches = STYLING_FLAGS
        .filter((flag) => readBoolean(pattern.metadata[flag]) === true)
        .sort(compare);

      if (activeApproaches.length < this.config.mixedStylingFileThreshold) {
        continue;
      }

      const severity: InsightSeverity = activeApproaches.length >= 3 ? "warning" : "info";
      const confidence = this.normalizeConfidence(Math.min(1, activeApproaches.length / 4));
      const fileName = fileNameFromPath(pattern.filePath);

      insights.push({
        id: this.buildInsightId("mixed-styling", `file:${pattern.filePath}`),
        category: "mixed-styling",
        severity,
        title: `Mixed styling in ${fileName}: ${activeApproaches.join(", ")}`,
        description: `${pattern.filePath} uses ${activeApproaches.length} styling approaches: ${activeApproaches.join(", ")}. Consider consolidating to a single approach per file.`,
        relatedPatterns: this.filterExistingOrdered(index, [pattern.id]),
        confidence,
        metadata: {
          filePath: pattern.filePath,
          activeApproaches,
          approachCount: activeApproaches.length,
        },
      });
    }

    return this.applyCategoryLimit(insights);
  }

  private detectArchitecturalSmells(
    index: IntelligenceIndex,
    adjacency: AdjacencyMaps,
    directoryPatterns: ReadonlyMap<string, PatternResult>,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
  ): Insight[] {
    const insights: Insight[] = [];

    // god-component
    for (const patternId of this.getTypeIds(index, "component", depToComponent)) {
      const pattern = index.entries.get(patternId);
      if (pattern === undefined) continue;

      const renderEdges = (adjacency.outgoing.get(patternId) ?? [])
        .filter((edge) => edge.kind === "render");
      const renderOutDegree = renderEdges.length;
      if (renderOutDegree <= this.config.godComponentOutDegree) {
        continue;
      }

      const childIds = uniquePatternIds(
        renderEdges.map((edge) => edge.to).filter((id) => index.entries.has(id)),
      ).sort(comparePatternId);
      const childComponents = uniqueSortedStrings(
        childIds.map((id) => index.entries.get(id)?.name).filter(isNonNullable),
      );
      const childFiles = uniqueSortedStrings(
        childIds.map((id) => index.entries.get(id)?.filePath).filter(isNonNullable),
      );
      const threshold = this.config.godComponentOutDegree;
      const severity: InsightSeverity = renderOutDegree > (2 * threshold) ? "error" : "warning";

      insights.push({
        id: this.buildInsightId("architectural-smell", `god-component:${patternId as string}`),
        category: "architectural-smell",
        severity,
        title: `God component: ${pattern.name} renders ${renderOutDegree} components`,
        description: `${pattern.name} in ${pattern.filePath} directly renders ${renderOutDegree} child components (threshold: ${threshold}). This component likely has too many responsibilities. Consider splitting into smaller, focused components.`,
        relatedPatterns: this.filterExistingOrdered(index, [patternId, ...childIds]),
        confidence: this.normalizeConfidence(Math.min(1, renderOutDegree / Math.max(1, 2 * threshold))),
        metadata: {
          subType: "god-component",
          renderOutDegree,
          childComponents,
          childFiles,
          threshold,
        },
      });
    }

    // wrong-directory: component in non-component directory
    for (const patternId of this.getTypeIds(index, "component", depToComponent)) {
      const pattern = index.entries.get(patternId);
      if (pattern === undefined) continue;
      const dirPath = directoryPathFromFile(pattern.filePath);
      const dirPattern = directoryPatterns.get(dirPath);
      if (dirPattern === undefined) continue;

      const role = readString(dirPattern.metadata["role"]);
      if (role === null || !NON_COMPONENT_DIRECTORY_ROLES.has(role)) {
        continue;
      }

      const roleScore = readNumber(dirPattern.metadata["roleScore"]) ?? 0;
      insights.push({
        id: this.buildInsightId("architectural-smell", `wrong-directory:${patternId as string}`),
        category: "architectural-smell",
        severity: "info",
        title: `Misplaced ${pattern.type}: ${pattern.name} in ${role}/ directory`,
        description: `${pattern.name} (${pattern.type}) is in ${dirPath} which is classified as '${role}'. Consider moving it to a more appropriate directory.`,
        relatedPatterns: this.filterExistingOrdered(index, [patternId, dirPattern.id]),
        confidence: this.normalizeConfidence(roleScore * 0.8),
        metadata: {
          subType: "wrong-directory",
          patternType: pattern.type,
          directoryRole: role,
          directoryRoleScore: roleScore,
          suggestedRole: "components",
        },
      });
    }

    // wrong-directory: utility in components directory
    for (const patternId of this.getTypeIds(index, "utility", depToComponent)) {
      const pattern = index.entries.get(patternId);
      if (pattern === undefined) continue;
      if (INFRA_UTILITY_NAMES.has(pattern.name)) continue;

      const dirPath = directoryPathFromFile(pattern.filePath);
      const dirPattern = directoryPatterns.get(dirPath);
      if (dirPattern === undefined) continue;

      const role = readString(dirPattern.metadata["role"]);
      if (role !== "components") {
        continue;
      }

      const roleScore = readNumber(dirPattern.metadata["roleScore"]) ?? 0;
      insights.push({
        id: this.buildInsightId("architectural-smell", `wrong-directory:${patternId as string}`),
        category: "architectural-smell",
        severity: "info",
        title: `Misplaced ${pattern.type}: ${pattern.name} in ${role}/ directory`,
        description: `${pattern.name} (${pattern.type}) is in ${dirPath} which is classified as '${role}'. Consider moving it to a more appropriate directory.`,
        relatedPatterns: this.filterExistingOrdered(index, [patternId, dirPattern.id]),
        confidence: this.normalizeConfidence(roleScore * 0.8),
        metadata: {
          subType: "wrong-directory",
          patternType: pattern.type,
          directoryRole: role,
          directoryRoleScore: roleScore,
          suggestedRole: "utils",
        },
      });
    }

    // excessive-props
    for (const patternId of this.getTypeIds(index, "component", depToComponent)) {
      const pattern = index.entries.get(patternId);
      if (pattern === undefined) continue;

      const propCount = readNumber(pattern.metadata["propCount"]);
      if (propCount === null || propCount <= this.config.excessivePropCount) {
        continue;
      }

      const requiredPropCount = readNumber(pattern.metadata["requiredPropCount"]) ?? 0;
      const threshold = this.config.excessivePropCount;

      insights.push({
        id: this.buildInsightId("architectural-smell", `excessive-props:${patternId as string}`),
        category: "architectural-smell",
        severity: "warning",
        title: `Excessive props: ${pattern.name} has ${propCount} props`,
        description: `${pattern.name} in ${pattern.filePath} accepts ${propCount} props (${requiredPropCount} required). Components with many props are hard to use and test. Consider grouping related props into objects, using context, or splitting the component.`,
        relatedPatterns: this.filterExistingOrdered(index, [patternId]),
        confidence: this.normalizeConfidence(Math.min(1, propCount / Math.max(1, 2 * threshold))),
        metadata: {
          subType: "excessive-props",
          propCount,
          requiredPropCount,
          threshold,
        },
      });
    }

    // inconsistent-naming
    const conventionsPattern = index.entries.get(".:conventions:1" as PatternId);
    const projectConvention = conventionsPattern === undefined
      ? null
      : readString(conventionsPattern.metadata["dominantFileNaming"]);
    const conventionsConfidence = conventionsPattern === undefined
      ? 0
      : clamp01(conventionsPattern.confidence.value);

    if (projectConvention !== null && conventionsPattern !== undefined) {
      const sortedDirectoryPatterns = [...directoryPatterns.values()]
        .sort((a, b) => compare(a.id as string, b.id as string));

      for (const directoryPattern of sortedDirectoryPatterns) {
        if (directoryPattern.filePath === ".") continue;

        const actualConvention = readString(directoryPattern.metadata["namingConvention"]);
        const fileCount = readNumber(directoryPattern.metadata["fileCount"]) ?? 0;
        if (
          actualConvention === null ||
          actualConvention === "unknown" ||
          actualConvention === projectConvention ||
          fileCount < 3
        ) {
          continue;
        }

        const confidence = this.normalizeConfidence(
          (conventionsConfidence * 0.6) + (fileCount >= 5 ? 0.4 : 0.2),
        );

        insights.push({
          id: this.buildInsightId("architectural-smell", `inconsistent-naming:${directoryPattern.filePath}`),
          category: "architectural-smell",
          severity: "info",
          title: `Inconsistent naming in ${directoryPattern.filePath}: ${actualConvention} (project uses ${projectConvention})`,
          description: `Files in ${directoryPattern.filePath} use ${actualConvention} naming but the project convention is ${projectConvention}. Consistent naming improves discoverability and reduces cognitive load.`,
          relatedPatterns: this.filterExistingOrdered(index, [directoryPattern.id, conventionsPattern.id]),
          confidence,
          metadata: {
            subType: "inconsistent-naming",
            directoryPath: directoryPattern.filePath,
            actualConvention,
            projectConvention,
            fileCount,
          },
        });
      }
    }

    // missing-barrel
    for (const directoryPattern of [...directoryPatterns.values()].sort((a, b) =>
      compare(a.id as string, b.id as string))) {
      const role = readString(directoryPattern.metadata["role"]);
      if (role !== "components" && role !== "hooks") {
        continue;
      }

      const fileCount = readNumber(directoryPattern.metadata["fileCount"]) ?? 0;
      const hasBarrel = readBoolean(directoryPattern.metadata["hasBarrel"]) === true;
      if (fileCount < this.config.missingBarrelMinExports || hasBarrel) {
        continue;
      }

      const roleScore = readNumber(directoryPattern.metadata["roleScore"]) ?? 0;
      insights.push({
        id: this.buildInsightId("architectural-smell", `missing-barrel:${directoryPattern.filePath}`),
        category: "architectural-smell",
        severity: "info",
        title: `Missing barrel export in ${directoryPattern.filePath} (${fileCount} files)`,
        description: `${directoryPattern.filePath} (role: ${role}) has ${fileCount} files but no index.ts barrel export. Barrel files simplify imports and provide a stable public API.`,
        relatedPatterns: this.filterExistingOrdered(index, [directoryPattern.id]),
        confidence: this.normalizeConfidence(0.6 * roleScore),
        metadata: {
          subType: "missing-barrel",
          directoryPath: directoryPattern.filePath,
          directoryRole: role,
          fileCount,
        },
      });
    }

    return this.applyCategoryLimit(insights);
  }

  private buildAdjacencyMaps(
    edges: readonly DependencyEdge[],
    depToComponent: ReadonlyMap<PatternId, PatternId>,
  ): AdjacencyMaps {
    const normalizedEdgeMap = new Map<string, DependencyEdge>();
    const sortedInputEdges = [...edges].sort(compareEdges);
    for (const edge of sortedInputEdges) {
      const fromComponent = this.resolveComponentId(edge.from, depToComponent);
      const toComponent = this.resolveComponentId(edge.to, depToComponent);
      const normalized: DependencyEdge = {
        from: fromComponent,
        to: toComponent,
        kind: edge.kind,
      };
      const key = `${normalized.from as string}|${normalized.to as string}|${normalized.kind}`;
      if (!normalizedEdgeMap.has(key)) {
        normalizedEdgeMap.set(key, normalized);
      }
    }
    const sortedEdges = [...normalizedEdgeMap.values()].sort(compareEdges);
    const outgoing = new Map<PatternId, DependencyEdge[]>();
    const incoming = new Map<PatternId, DependencyEdge[]>();

    for (const edge of sortedEdges) {
      const out = outgoing.get(edge.from);
      if (out === undefined) {
        outgoing.set(edge.from, [edge]);
      } else {
        out.push(edge);
      }

      const inc = incoming.get(edge.to);
      if (inc === undefined) {
        incoming.set(edge.to, [edge]);
      } else {
        inc.push(edge);
      }
    }

    const inDegree = new Map<PatternId, number>();
    const outDegree = new Map<PatternId, number>();
    const renderInDegree = new Map<PatternId, number>();

    for (const [id, list] of incoming) {
      inDegree.set(id, list.length);
      renderInDegree.set(id, list.filter((edge) => edge.kind === "render").length);
    }
    for (const [id, list] of outgoing) {
      outDegree.set(id, list.length);
      if (!inDegree.has(id)) {
        inDegree.set(id, 0);
      }
      if (!renderInDegree.has(id)) {
        renderInDegree.set(id, 0);
      }
    }

    return {
      outgoing: sortEdgeMap(outgoing),
      incoming: sortEdgeMap(incoming),
      inDegree: sortNumericMap(inDegree),
      outDegree: sortNumericMap(outDegree),
      renderInDegree: sortNumericMap(renderInDegree),
    };
  }

  private buildEdgeConfidenceLookup(
    index: IntelligenceIndex,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
  ): EdgeConfidenceLookup {
    const bySource = new Map<PatternId, Map<string, number>>();
    const sortedIds = [...index.entries.keys()].sort(comparePatternId);

    for (const id of sortedIds) {
      const pattern = index.entries.get(id);
      if (pattern === undefined) continue;

      const sourcePatternIdRaw = readString(pattern.metadata["sourcePatternId"]);
      if (sourcePatternIdRaw === null) continue;
      const sourcePatternId = this.resolveComponentId(sourcePatternIdRaw as PatternId, depToComponent);

      const edgeEntries = readRecordArray(pattern.metadata["edges"]);
      if (edgeEntries.length === 0) continue;

      const targetMap = bySource.get(sourcePatternId) ?? new Map<string, number>();
      for (const edgeEntry of edgeEntries) {
        const target = readString(edgeEntry["target"]);
        if (target === null) continue;
        const targetComponent = this.resolveComponentId(target as PatternId, depToComponent);
        const confidence = readNumber(edgeEntry["confidence"]);
        if (confidence === null) continue;
        const kind = readString(edgeEntry["kind"]);
        const normalized = clamp01(confidence);
        const exactKey = `${targetComponent as string}|${kind ?? "*"}`;
        const targetOnlyKey = `${targetComponent as string}|*`;
        const prevExact = targetMap.get(exactKey);
        const prevTargetOnly = targetMap.get(targetOnlyKey);
        if (prevExact === undefined || normalized > prevExact) {
          targetMap.set(exactKey, normalized);
        }
        if (prevTargetOnly === undefined || normalized > prevTargetOnly) {
          targetMap.set(targetOnlyKey, normalized);
        }
      }
      bySource.set(sourcePatternId, targetMap);
    }

    const normalizedBySource = new Map<PatternId, ReadonlyMap<string, number>>();
    for (const [sourceId, values] of bySource) {
      normalizedBySource.set(sourceId, new Map([...values.entries()].sort((a, b) => compare(a[0], b[0]))));
    }

    return {
      bySource: new Map(
        [...normalizedBySource.entries()].sort((a, b) => comparePatternId(a[0], b[0])),
      ),
    };
  }

  private collectDirectoryPatterns(index: IntelligenceIndex): ReadonlyMap<string, PatternResult> {
    const map = new Map<string, PatternResult>();
    const sortedIds = [...index.entries.keys()].sort(comparePatternId);
    for (const id of sortedIds) {
      const pattern = index.entries.get(id);
      if (pattern === undefined || pattern.name !== "directory") {
        continue;
      }
      map.set(normalizePath(pattern.filePath), pattern);
    }
    return new Map([...map.entries()].sort((a, b) => compare(a[0], b[0])));
  }

  private collectBarrelExposure(index: IntelligenceIndex): ReadonlySet<string> {
    const exportedFiles = new Set<string>();
    const sortedIds = [...index.entries.keys()].sort(comparePatternId);

    for (const id of sortedIds) {
      const pattern = index.entries.get(id);
      if (pattern === undefined) continue;
      if (readBoolean(pattern.metadata["isBarrel"]) !== true) continue;

      for (const reExport of readRecordArray(pattern.metadata["reExports"])) {
        const resolvedPath = readString(reExport["resolvedPath"]);
        if (resolvedPath !== null) {
          exportedFiles.add(normalizePath(resolvedPath));
        }
      }

      for (const imp of readRecordArray(pattern.metadata["imports"])) {
        const statementKind = readString(imp["statementKind"]);
        if (statementKind !== "re-export") continue;
        const resolvedPath = readString(imp["resolvedPath"]);
        if (resolvedPath !== null) {
          exportedFiles.add(normalizePath(resolvedPath));
        }
      }
    }

    return new Set([...exportedFiles].sort(compare));
  }

  private lookupDirectoryRole(
    directoryPatterns: ReadonlyMap<string, PatternResult>,
    filePath: string,
  ): string | null {
    const directoryPattern = directoryPatterns.get(directoryPathFromFile(filePath));
    if (directoryPattern === undefined) {
      return null;
    }
    return readString(directoryPattern.metadata["role"]);
  }

  private isPageOrEntryComponent(
    pattern: PatternResult,
    directoryPatterns: ReadonlyMap<string, PatternResult>,
  ): boolean {
    if (this.config.orphanExcludeTypes.includes(pattern.type)) {
      return true;
    }

    const role = this.lookupDirectoryRole(directoryPatterns, pattern.filePath);
    if (role !== null && this.config.orphanExcludeRoles.includes(role)) {
      return true;
    }

    const normalizedPath = normalizePath(pattern.filePath);
    const isDefaultExport = readBoolean(pattern.metadata["isDefaultExport"]) === true;
    if (isDefaultExport && /^src\/(?:App|index|main)\.[^/]+$/.test(normalizedPath)) {
      return true;
    }

    return false;
  }

  private buildInsightId(category: InsightType, discriminator: string): string {
    return `${category}:${discriminator}`;
  }

  private applyCategoryLimit(insights: readonly Insight[]): Insight[] {
    const sorted = [...insights].sort((a, b) =>
      (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
      (b.confidence - a.confidence) ||
      compare(a.id, b.id)
    );
    return sorted.slice(0, this.config.maxInsightsPerCategory);
  }

  private filterExistingSorted(
    index: IntelligenceIndex,
    ids: readonly PatternId[],
  ): PatternId[] {
    return uniquePatternIds(ids.filter((id) => index.entries.has(id))).sort(comparePatternId);
  }

  private filterExistingOrdered(
    index: IntelligenceIndex,
    ids: readonly PatternId[],
  ): PatternId[] {
    const seen = new Set<string>();
    const filtered: PatternId[] = [];
    for (const id of ids) {
      const key = id as string;
      if (seen.has(key)) continue;
      if (!index.entries.has(id)) continue;
      seen.add(key);
      filtered.push(id);
    }
    return filtered;
  }

  private lookupEdgeConfidence(
    edge: DependencyEdge,
    lookup: EdgeConfidenceLookup,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
    fallback: number,
  ): number {
    const sourceComponent = this.resolveComponentId(edge.from, depToComponent);
    const sourceLookup = lookup.bySource.get(sourceComponent);
    if (sourceLookup === undefined) {
      return fallback;
    }

    const target = this.resolveComponentId(edge.to, depToComponent) as string;
    const exact = sourceLookup.get(`${target}|${edge.kind}`);
    if (exact !== undefined) {
      return clamp01(exact);
    }

    const targetOnly = sourceLookup.get(`${target}|*`);
    if (targetOnly !== undefined) {
      return clamp01(targetOnly);
    }

    return fallback;
  }

  private computeInsightsHash(insights: readonly Insight[]): string {
    return createHash("sha256")
      .update(stableStringify(insights))
      .digest("hex");
  }

  private normalizeConfidence(value: number): number {
    return round3(clamp01(value));
  }

  private getTypeIds(
    index: IntelligenceIndex,
    type: PatternType,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
  ): PatternId[] {
    const ids = index.typeIndex.get(type);
    if (ids === undefined) {
      return [];
    }
    return uniquePatternIds(
      [...ids].map((id) => this.resolveComponentId(id, depToComponent)),
    ).sort(comparePatternId);
  }

  private buildDepToComponentMap(index: IntelligenceIndex): ReadonlyMap<PatternId, PatternId> {
    const map = new Map<PatternId, PatternId>();
    const sortedIds = [...index.entries.keys()].sort(comparePatternId);
    for (const id of sortedIds) {
      const pattern = index.entries.get(id);
      if (pattern === undefined) continue;

      const sourcePatternId = readString(pattern.metadata["sourcePatternId"]);
      if (sourcePatternId === null) continue;
      map.set(id, sourcePatternId as PatternId);
    }
    return new Map([...map.entries()].sort((a, b) => comparePatternId(a[0], b[0])));
  }

  private resolveComponentId(
    id: PatternId,
    depToComponent: ReadonlyMap<PatternId, PatternId>,
  ): PatternId {
    return depToComponent.get(id) ?? id;
  }
}

function comparePatternId(a: PatternId, b: PatternId): number {
  return compare(a as string, b as string);
}

function compareEdges(a: DependencyEdge, b: DependencyEdge): number {
  return compare(a.from as string, b.from as string) ||
    compare(a.to as string, b.to as string) ||
    compare(a.kind, b.kind);
}

function sortEdgeMap(
  value: ReadonlyMap<PatternId, readonly DependencyEdge[]>,
): ReadonlyMap<PatternId, readonly DependencyEdge[]> {
  return new Map(
    [...value.entries()]
      .sort((a, b) => comparePatternId(a[0], b[0]))
      .map(([id, edges]) => [id, [...edges].sort(compareEdges)]),
  );
}

function sortNumericMap(
  value: ReadonlyMap<PatternId, number>,
): ReadonlyMap<PatternId, number> {
  return new Map([...value.entries()].sort((a, b) => comparePatternId(a[0], b[0])));
}

function uniquePatternIds(ids: readonly PatternId[]): PatternId[] {
  const seen = new Set<string>();
  const result: PatternId[] = [];
  for (const id of ids) {
    const key = id as string;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(id);
  }
  return result;
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function percentileOfDegree(sortedDegrees: readonly number[], degree: number): number {
  if (sortedDegrees.length === 0) return 0;
  let count = 0;
  for (const value of sortedDegrees) {
    if (value <= degree) {
      count += 1;
    }
  }
  return count / sortedDegrees.length;
}

function readPatternIdArray(value: unknown): PatternId[] {
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

function readStringArrayOrdered(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push(item);
    }
  }
  return result;
}

function readNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  const keys = Object.keys(value).sort(compare);
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    }
  }
  return result;
}

function readRecordArray(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (isRecord(item)) {
      result.push(item);
    }
  }
  return result;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(path: string): string {
  const forward = path.replace(/\\/g, "/");
  const stripped = forward.startsWith("./") ? forward.slice(2) : forward;
  const segments = stripped.split("/").filter((segment) => segment.length > 0);
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.length === 0 ? "." : normalized.join("/");
}

function directoryPathFromFile(filePath: string): string {
  const normalized = normalizePath(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return ".";
  }
  return normalized.slice(0, lastSlash);
}

function fileNameFromPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return normalized;
  }
  return normalized.slice(lastSlash + 1);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function geometricMean(values: readonly number[], fallback: number): number {
  if (values.length === 0) {
    return fallback;
  }
  const epsilon = 1e-6;
  const sum = values.reduce((acc, value) => acc + Math.log(Math.max(epsilon, clamp01(value))), 0);
  return Math.exp(sum / values.length);
}

function isNonNullable<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
