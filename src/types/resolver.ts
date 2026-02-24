import type { PatternResult, PatternType } from "./pattern.js";
import type { DependencyEdge } from "./intelligence.js";

/** How to search the index */
export type ResolverQueryKind =
  | "by-name"
  | "by-path"
  | "by-pattern-type"
  | "by-dependency";

/**
 * A query against the IntelligenceIndex.
 *
 * Designed for both programmatic use (CLI resolve command) and
 * interactive use (watch mode, editor integration). The depth
 * field controls transitive dependency expansion — 0 means
 * direct matches only, Infinity means full graph traversal.
 */
export interface ResolverQuery {
  readonly kind: ResolverQueryKind;

  /** The search target: a name, glob pattern, file path, or pattern ID */
  readonly target: string;

  /** Narrow results to specific pattern types */
  readonly typeFilter?: readonly PatternType[];

  /** Narrow results to specific frameworks */
  readonly frameworkFilter?: readonly string[];

  /** Depth for dependency traversal. 0 = direct only. Defaults to 1. */
  readonly depth?: number;

  /** Include transitive dependencies in the result graph. Defaults to false. */
  readonly includeTransitive?: boolean;
}

/**
 * The fully resolved result of a query.
 *
 * Contains not just the matches but the subgraph of dependencies
 * they participate in, enabling tree-shaking analysis, impact
 * assessment, and visualization without a second query.
 */
export interface ResolvedContext {
  /** The original query, for traceability */
  readonly query: ResolverQuery;

  /** Direct matches for the query */
  readonly matches: readonly PatternResult[];

  /** Dependency edges within the resolved subgraph */
  readonly edges: readonly DependencyEdge[];

  /** Patterns reachable through transitive dependencies (if requested) */
  readonly transitiveDependencies: readonly PatternResult[];

  /** Patterns that depend on the matches (reverse edges, 1 level) */
  readonly dependents: readonly PatternResult[];

  /** Wall-clock duration of the resolve operation */
  readonly duration: number;
}
