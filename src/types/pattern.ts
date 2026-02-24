import type { PatternId } from "./brand.js";
import type { SourceSpan } from "./file.js";

/**
 * Confidence score with full attribution.
 *
 * A bare 0-1 number is useless for debugging. Every score must explain
 * *why* it has that value via weighted factors. This makes threshold
 * tuning data-driven instead of guesswork.
 */
export interface ConfidenceScore {
  /** Aggregate score in [0, 1] — weighted sum of factors */
  readonly value: number;

  /** Human-readable origin: "naming-convention", "ast-structure", "export-analysis" */
  readonly source: string;

  /** Individual scoring signals. Weights must sum to 1. */
  readonly factors: readonly ConfidenceFactor[];
}

export interface ConfidenceFactor {
  readonly name: string;
  readonly weight: number;
  readonly score: number;
}

/** The kind of pattern an analyzer can discover */
export type PatternType =
  | "component"
  | "hook"
  | "utility"
  | "layout"
  | "page"
  | "provider"
  | "hoc"
  | "directive"
  | "composable";

/**
 * A single pattern discovered by an analyzer.
 *
 * Immutable by design — once emitted, a PatternResult is never mutated.
 * Downstream consumers (index, resolver) build their own data structures
 * on top of the raw results.
 */
export interface PatternResult {
  readonly id: PatternId;
  readonly type: PatternType;
  readonly name: string;
  readonly filePath: string;
  readonly location: SourceSpan;
  readonly confidence: ConfidenceScore;

  /** Framework that owns this pattern: "react", "vue", "svelte", "angular" */
  readonly framework: string;

  /** Direct dependency IDs (imports, slot usage, render calls) */
  readonly dependencies: readonly PatternId[];

  /** Props, slots, events — varies by pattern type */
  readonly properties: Readonly<Record<string, PatternProperty>>;

  /** Escape hatch for analyzer-specific data. Must be JSON-serializable. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Describes a single property (prop, slot, event) of a pattern.
 *
 * Named PatternProperty — NOT PropertyDescriptor — to avoid
 * shadowing the built-in TypeScript PropertyDescriptor from lib.es5.d.ts.
 */
export interface PatternProperty {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue?: string;
}
