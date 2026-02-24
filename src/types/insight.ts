import type { PatternId } from "./brand.js";

export type InsightType =
  | "hub-component"
  | "orphan-component"
  | "dependency-cycle"
  | "deep-dependency-chain"
  | "mixed-styling"
  | "architectural-smell"
  | "low-coverage-hub"
  | "performance-bottleneck";

export type InsightSeverity = "info" | "warning" | "error";

export interface Insight {
  readonly id: string;
  readonly category: InsightType;
  readonly severity: InsightSeverity;
  readonly title: string;
  readonly description: string;
  readonly relatedPatterns: readonly PatternId[];
  readonly confidence: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface InsightEngineResult {
  readonly insights: readonly Insight[];
  readonly hash: string;
  readonly durationMs: number;
  readonly stats: {
    readonly total: number;
    readonly byType: Readonly<Record<string, number>>;
  };
}
