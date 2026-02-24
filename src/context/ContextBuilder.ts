import { compare } from "../core/utils.js";
import { QueryEngine } from "../query/QueryEngine.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ProjectContext {
  readonly summary: {
    readonly totalComponents: number;
    readonly totalInsights: number;
    readonly hubCount: number;
    readonly deepChainCount: number;
  };
  readonly components: readonly ComponentContext[];
  readonly insights: readonly InsightContext[];
  readonly deepChains: readonly ChainContext[];
  readonly hubs: readonly HubContext[];
}

export interface ComponentContext {
  readonly name: string;
  readonly filePath: string;
  readonly dependencyCount: number;
  readonly dependentCount: number;
  readonly isHub: boolean;
  readonly isOrphan: boolean;
}

export interface InsightContext {
  readonly type: string;
  readonly severity: string;
  readonly confidence: number;
  readonly component?: string;
  readonly message?: string;
}

export interface ChainContext {
  readonly length: number;
  readonly root: string;
  readonly leaf: string;
  readonly components: readonly string[];
}

export interface HubContext {
  readonly component: string;
  readonly dependentCount: number;
  readonly confidence: number;
}

// -----------------------------------------------------------------------------
// ContextBuilder
// -----------------------------------------------------------------------------

export class ContextBuilder {
  private readonly rootPath: string;
  private engine: QueryEngine | null = null;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async load(): Promise<void> {
    const engine = new QueryEngine(this.rootPath);
    await engine.load();
    this.engine = engine;
  }

  buildProjectContext(): ProjectContext {
    const engine = this.ensureLoaded();
    const stats = engine.getStats();

    const hubs = this.buildHubs(engine);
    const deepChains = this.buildChains(engine);
    const components = this.buildComponents(engine, hubs);
    const insights = this.buildInsights(engine);

    return {
      summary: {
        totalComponents: stats.totalComponents,
        totalInsights: stats.totalInsights,
        hubCount: hubs.length,
        deepChainCount: deepChains.length,
      },
      components,
      insights,
      deepChains,
      hubs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: build components
  // ---------------------------------------------------------------------------

  private buildComponents(engine: QueryEngine, hubs: readonly HubContext[]): readonly ComponentContext[] {
    const stats = engine.getStats();
    const hubNames = new Set(hubs.map((h) => h.component));
    const orphanInsights = engine.findInsights("orphan-component");
    const orphanIds = new Set<string>();
    for (const insight of orphanInsights) {
      for (const id of insight.relatedPatterns) {
        orphanIds.add(id as string);
      }
    }

    const components: ComponentContext[] = [];

    // Collect all component names by probing the engine
    // We iterate stats.totalComponents worth of names by querying known patterns
    // The engine exposes findComponent by name — we need to discover names.
    // Since we cannot enumerate the engine's internal map, we extract component
    // names from insights and dependency lookups. However, the cleanest approach
    // is to collect names from hub/orphan insights + dependency traversal.
    //
    // Actually, we can discover all component names by checking every insight's
    // relatedPatterns and collecting unique pattern names. But a more reliable
    // approach: since QueryEngine.findComponent does exact name match and
    // getStats tells us total components, we need a way to enumerate.
    //
    // The best approach given the QueryEngine API: collect all names from
    // insights (relatedPatterns → patternId → extract name from id format),
    // plus hub/orphan/chain insights. PatternId format: `filePath:name:line`.
    const knownNames = new Set<string>();

    // Extract names from all insight types
    const allTypes = [
      "hub-component",
      "orphan-component",
      "dependency-cycle",
      "deep-dependency-chain",
      "mixed-styling",
      "architectural-smell",
    ] as const;

    for (const type of allTypes) {
      const typeInsights = engine.findInsights(type);
      for (const insight of typeInsights) {
        for (const patternId of insight.relatedPatterns) {
          const name = extractNameFromPatternId(patternId as string);
          if (name !== null) {
            knownNames.add(name);
          }
        }
      }
    }

    // Also try to extract from hub dependents and chain components
    for (const hub of hubs) {
      knownNames.add(hub.component);
      const dependents = engine.findDependents(hub.component);
      for (const dep of dependents) {
        knownNames.add(dep.name);
      }
      const dependencies = engine.findDependencies(hub.component);
      for (const dep of dependencies) {
        knownNames.add(dep.name);
      }
    }

    // Expand via dependency/dependent traversal for discovered names
    const toExpand = [...knownNames];
    const expanded = new Set<string>();
    while (toExpand.length > 0) {
      const name = toExpand.pop()!;
      if (expanded.has(name)) continue;
      expanded.add(name);

      const deps = engine.findDependencies(name);
      for (const dep of deps) {
        if (!expanded.has(dep.name)) {
          knownNames.add(dep.name);
          toExpand.push(dep.name);
        }
      }
      const dependents = engine.findDependents(name);
      for (const dep of dependents) {
        if (!expanded.has(dep.name)) {
          knownNames.add(dep.name);
          toExpand.push(dep.name);
        }
      }
    }

    for (const name of [...knownNames].sort(compare)) {
      const pattern = engine.findComponent(name);
      if (pattern === null) continue;

      const deps = engine.findDependencies(name);
      const dependents = engine.findDependents(name);

      components.push({
        name: pattern.name,
        filePath: pattern.filePath,
        dependencyCount: deps.length,
        dependentCount: dependents.length,
        isHub: hubNames.has(pattern.name),
        isOrphan: orphanIds.has(pattern.id as string),
      });
    }

    // If we discovered fewer than stats report, that's acceptable — we only
    // expose components reachable through the insight/dependency graph.
    void stats;

    return components;
  }

  // ---------------------------------------------------------------------------
  // Private: build insights
  // ---------------------------------------------------------------------------

  private buildInsights(engine: QueryEngine): readonly InsightContext[] {
    const allTypes = [
      "hub-component",
      "orphan-component",
      "dependency-cycle",
      "deep-dependency-chain",
      "mixed-styling",
      "architectural-smell",
    ] as const;

    const insights: InsightContext[] = [];

    for (const type of allTypes) {
      const typeInsights = engine.findInsights(type);
      for (const insight of typeInsights) {
        const component = insight.relatedPatterns.length > 0
          ? extractNameFromPatternId(insight.relatedPatterns[0] as string) ?? undefined
          : undefined;

        insights.push({
          type: insight.category,
          severity: insight.severity,
          confidence: insight.confidence,
          component,
          message: insight.title || undefined,
        });
      }
    }

    return insights.sort((a, b) =>
      compare(a.type, b.type) ||
      compare(a.severity, b.severity) ||
      (b.confidence - a.confidence) ||
      compare(a.component ?? "", b.component ?? "") ||
      compare(a.message ?? "", b.message ?? ""),
    );
  }

  // ---------------------------------------------------------------------------
  // Private: build hubs
  // ---------------------------------------------------------------------------

  private buildHubs(engine: QueryEngine): readonly HubContext[] {
    const hubInsights = engine.findHubComponents();
    const hubs: HubContext[] = [];

    for (const insight of hubInsights) {
      const componentName = insight.relatedPatterns.length > 0
        ? extractNameFromPatternId(insight.relatedPatterns[0] as string)
        : null;

      if (componentName === null) continue;

      const renderInDegree = typeof insight.metadata["renderInDegree"] === "number"
        ? insight.metadata["renderInDegree"]
        : 0;

      hubs.push({
        component: componentName,
        dependentCount: renderInDegree,
        confidence: insight.confidence,
      });
    }

    return hubs.sort((a, b) =>
      compare(a.component, b.component),
    );
  }

  // ---------------------------------------------------------------------------
  // Private: build chains
  // ---------------------------------------------------------------------------

  private buildChains(engine: QueryEngine): readonly ChainContext[] {
    const chainInsights = engine.findDeepChains();
    const chains: ChainContext[] = [];

    for (const insight of chainInsights) {
      const depth = typeof insight.metadata["depth"] === "number"
        ? insight.metadata["depth"]
        : 0;

      const rootId = typeof insight.metadata["rootPatternId"] === "string"
        ? insight.metadata["rootPatternId"]
        : "";

      const leafId = typeof insight.metadata["leafPatternId"] === "string"
        ? insight.metadata["leafPatternId"]
        : "";

      const chainIds = Array.isArray(insight.metadata["chain"])
        ? (insight.metadata["chain"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];

      const root = extractNameFromPatternId(rootId) ?? rootId;
      const leaf = extractNameFromPatternId(leafId) ?? leafId;
      const components = chainIds
        .map((id) => extractNameFromPatternId(id) ?? id)
        .filter((name) => name.length > 0);

      chains.push({
        length: depth,
        root,
        leaf,
        components,
      });
    }

    return chains.sort((a, b) =>
      compare(a.root, b.root) ||
      compare(a.leaf, b.leaf),
    );
  }

  // ---------------------------------------------------------------------------
  // Private: guard
  // ---------------------------------------------------------------------------

  private ensureLoaded(): QueryEngine {
    if (this.engine === null) {
      throw new Error("ContextBuilder: not loaded — call load() first");
    }
    return this.engine;
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Extract the component name from a PatternId.
 *
 * PatternId format: `filePath:name:line`
 * Examples:
 *   "src/components/Button.tsx:Button:1" → "Button"
 *   "src/App.tsx:App:dep:1"              → "App"
 *
 * Strategy: split on ":", take second-to-last non-numeric segment
 * that isn't "dep". For the standard format `path:name:lineNumber`,
 * the name is at index `segments.length - 2`.
 */
function extractNameFromPatternId(patternId: string): string | null {
  const segments = patternId.split(":");
  if (segments.length < 3) return null;

  // Standard: path:name:line or path:name:dep:line
  // The name is always the segment after the file path (which contains "/" or ".")
  // Find the first segment that doesn't look like a path
  // Simple: second-to-last segment, or third-to-last if second-to-last is "dep"
  const last = segments[segments.length - 1]!;
  const secondLast = segments[segments.length - 2]!;

  if (/^\d+$/.test(last)) {
    if (secondLast === "dep" && segments.length >= 4) {
      return segments[segments.length - 3] ?? null;
    }
    return secondLast;
  }

  return null;
}
