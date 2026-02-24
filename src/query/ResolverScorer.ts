import { compare } from "../core/utils.js";
import type { PatternId } from "../types/index.js";
import type { MatchKind, SearchMatch } from "./InvertedIndex.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Detailed breakdown of a single token's contribution to the score. */
export interface MatchDetail {
  readonly token: string;
  readonly kind: MatchKind;
  readonly weight: number;
  readonly description: string;
}

/** A search match enriched with a numeric relevance score and debug reasons. */
export interface ScoredMatch {
  readonly patternId: PatternId;
  readonly score: number;
  readonly matchedTokens: readonly string[];
  readonly reasons: readonly MatchDetail[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const WEIGHT_MAP: Readonly<Record<MatchKind, number>> = {
  exact: 1.0,
  synonym: 0.5,
  fuzzy: 0.2,
};

const KIND_LABEL: Readonly<Record<MatchKind, string>> = {
  exact: "Exact token match",
  synonym: "Synonym expansion match",
  fuzzy: "Fuzzy match (edit distance ≤ 1)",
};

// -----------------------------------------------------------------------------
// ResolverScorer
// -----------------------------------------------------------------------------

/**
 * Scores `SearchMatch` results produced by `InvertedIndex.search`.
 *
 * Scoring weights:
 *  - exact  match: +1.0 per token
 *  - synonym match: +0.5 per token
 *  - fuzzy  match: +0.2 per token
 *
 * Results are sorted by score descending, then by patternId ascending
 * for determinism.
 */
export class ResolverScorer {
  static readonly EXACT_WEIGHT = 1.0;
  static readonly SYNONYM_WEIGHT = 0.5;
  static readonly FUZZY_WEIGHT = 0.2;

  /**
   * Score an array of search matches and return them sorted by relevance.
   *
   * Each scored match includes a `reasons` array with per-token detail:
   * token name, match kind, numeric weight, and a human-readable description.
   *
   * @param matches - Raw search matches from `InvertedIndex.search`.
   * @returns Scored matches sorted by score desc, then patternId asc.
   */
  scoreMatches(matches: readonly SearchMatch[]): readonly ScoredMatch[] {
    const scored: ScoredMatch[] = [];

    for (const match of matches) {
      let score = 0;
      const reasons: MatchDetail[] = [];

      for (const tm of match.matchKinds) {
        const weight = WEIGHT_MAP[tm.kind];
        score += weight;
        reasons.push({
          token: tm.token,
          kind: tm.kind,
          weight,
          description: `${KIND_LABEL[tm.kind]} on "${tm.token}" (+${weight.toFixed(1)})`,
        });
      }

      scored.push({
        patternId: match.patternId,
        score,
        matchedTokens: match.matchedTokens,
        reasons,
      });
    }

    // Sort by score descending, then patternId ascending for determinism
    return scored.sort(
      (a, b) =>
        (b.score - a.score) ||
        compare(a.patternId as string, b.patternId as string),
    );
  }
}
