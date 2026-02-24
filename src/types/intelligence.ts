import type { PatternId, OutputHash } from "./brand.js";
import type { PatternResult, PatternType } from "./pattern.js";

/** A directional edge in the dependency graph */
export interface DependencyEdge {
  readonly from: PatternId;
  readonly to: PatternId;
  readonly kind: "import" | "render" | "slot" | "inject" | "extend" | "hook-usage" | "hoc-wrapping" | "provider";
}

/**
 * The unified intelligence index — the merged, queryable product
 * of all analyzer outputs.
 *
 * Built incrementally: when a single analyzer re-runs, only its
 * slice of the index is replaced. The composite hash changes only
 * when actual patterns change, which prevents false cache busts
 * in downstream consumers.
 */
export interface IntelligenceIndex {
  /** Schema version for forward-compatibility gating */
  readonly schemaVersion: number;

  /** Monotonically increasing build number */
  readonly buildNumber: number;

  /** Hash of all merged analyzer output hashes — changes only on real diffs */
  readonly compositeHash: OutputHash;

  /** All discovered patterns, keyed by stable ID */
  readonly entries: ReadonlyMap<PatternId, PatternResult>;

  /** Full dependency graph across all analyzers */
  readonly edges: readonly DependencyEdge[];

  /** Reverse lookup: file path → pattern IDs in that file */
  readonly fileIndex: ReadonlyMap<string, readonly PatternId[]>;

  /** Type-based grouping for fast filtered queries */
  readonly typeIndex: ReadonlyMap<PatternType, readonly PatternId[]>;

  readonly stats: IndexStats;
}

export interface IndexStats {
  readonly totalPatterns: number;
  readonly totalEdges: number;
  readonly totalFiles: number;
  readonly byFramework: Readonly<Record<string, number>>;
  readonly byType: Readonly<Record<string, number>>;
}
