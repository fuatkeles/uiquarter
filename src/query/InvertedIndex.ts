import { compare } from "../core/utils.js";
import type { PatternId, PatternResult } from "../types/index.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** The kind of match that linked a token to a pattern. */
export type MatchKind = "exact" | "fuzzy" | "synonym";

/** A single token and the kind of match that produced it. */
export interface TokenMatch {
  readonly token: string;
  readonly kind: MatchKind;
}

/** A pattern matched by search, with details about how it matched. */
export interface SearchMatch {
  readonly patternId: PatternId;
  readonly matchedTokens: readonly string[];
  readonly matchKinds: readonly TokenMatch[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const STOP_WORDS = new Set(["the", "and", "component", "module", "src", "index"]);

/** Lower number = higher priority when the same token matches via multiple kinds. */
const KIND_PRIORITY: Readonly<Record<MatchKind, number>> = { exact: 0, synonym: 1, fuzzy: 2 };

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["modal", "dialog", "popup", "overlay", "sheet"],
  ["sidebar", "panel"],
];

const SYNONYM_MAP = new Map<string, readonly string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    SYNONYM_MAP.set(word, group.filter((w) => w !== word));
  }
}

// -----------------------------------------------------------------------------
// InvertedIndex
// -----------------------------------------------------------------------------

/**
 * Deterministic inverted index over PatternResult tokens.
 *
 * Extracts searchable tokens from pattern names, file paths, and metadata,
 * then provides fast lookup by token, keyword, or fuzzy/synonym search.
 */
export class InvertedIndex {
  private readonly tokenToPatterns: Map<string, Set<PatternId>>;
  private readonly patternToTokens: Map<PatternId, Set<string>>;
  private readonly componentToPatterns: Map<string, Set<PatternId>>;

  constructor(patterns: readonly PatternResult[]) {
    this.tokenToPatterns = new Map();
    this.patternToTokens = new Map();
    this.componentToPatterns = new Map();

    const sorted = [...patterns].sort((a, b) => compare(a.id as string, b.id as string));

    for (const pattern of sorted) {
      const tokens = extractTokens(pattern);

      this.patternToTokens.set(pattern.id, new Set([...tokens].sort(compare)));

      for (const token of tokens) {
        let set = this.tokenToPatterns.get(token);
        if (set === undefined) {
          set = new Set();
          this.tokenToPatterns.set(token, set);
        }
        set.add(pattern.id);
      }

      let nameSet = this.componentToPatterns.get(pattern.name);
      if (nameSet === undefined) {
        nameSet = new Set();
        this.componentToPatterns.set(pattern.name, nameSet);
      }
      nameSet.add(pattern.id);
    }
  }

  /**
   * Return pattern IDs that contain the given exact token.
   */
  getPatternsForToken(token: string): readonly PatternId[] {
    const normalized = normalizeToken(token);
    const set = this.tokenToPatterns.get(normalized);
    if (set === undefined) return [];
    return [...set].sort((a, b) => compare(a as string, b as string));
  }

  /**
   * Return the union of pattern IDs matching any of the given tokens.
   */
  getPatternsForTokens(tokens: readonly string[]): readonly PatternId[] {
    const result = new Set<PatternId>();
    for (const token of tokens) {
      const normalized = normalizeToken(token);
      const set = this.tokenToPatterns.get(normalized);
      if (set !== undefined) {
        for (const id of set) {
          result.add(id);
        }
      }
    }
    return [...result].sort((a, b) => compare(a as string, b as string));
  }

  /**
   * Return the sorted list of tokens extracted from the given pattern.
   * @throws Error if the pattern ID was not indexed.
   */
  getTokensForPattern(patternId: PatternId): readonly string[] {
    const set = this.patternToTokens.get(patternId);
    if (set === undefined) {
      throw new Error(`Pattern '${patternId as string}' not indexed`);
    }
    return [...set].sort(compare);
  }

  /**
   * Return all unique tokens across every indexed pattern, sorted.
   */
  getAllTokens(): readonly string[] {
    return [...this.tokenToPatterns.keys()].sort(compare);
  }

  /**
   * Tokenize free-form input and search the index.
   *
   * Each result carries the matched tokens and how they matched (exact,
   * fuzzy, or synonym). When the same token qualifies via multiple kinds
   * the highest-priority kind wins (exact > synonym > fuzzy).
   *
   * @param input - Free-form text to search for.
   * @param options.fuzzy - If true, include tokens within edit distance 1.
   * @param options.synonyms - If true, expand tokens using the synonym table.
   * @returns Sorted SearchMatch array (by patternId ascending).
   */
  search(
    input: string,
    options?: { fuzzy?: boolean; synonyms?: boolean },
  ): readonly SearchMatch[] {
    const baseTokens = tokenizeInput(input);

    // Track every expanded token and its best match kind
    const tokenKinds = new Map<string, MatchKind>();

    const setKind = (token: string, kind: MatchKind): void => {
      const existing = tokenKinds.get(token);
      if (existing === undefined || KIND_PRIORITY[kind] < KIND_PRIORITY[existing]) {
        tokenKinds.set(token, kind);
      }
    };

    // Base tokens are exact matches
    for (const t of baseTokens) {
      setKind(t, "exact");
    }

    // Fuzzy first: expand query tokens to near-match index tokens AND synonym keys
    if (options?.fuzzy === true) {
      const allIndexTokens = this.getAllTokens();
      const synonymKeys = [...SYNONYM_MAP.keys()];
      const fuzzyTargets = [...new Set([...allIndexTokens, ...synonymKeys])].sort(compare);
      for (const queryToken of baseTokens) {
        for (const target of fuzzyTargets) {
          if (target === queryToken) continue;
          if (editDistance(queryToken, target) <= 1) {
            setKind(target, "fuzzy");
          }
        }
      }
    }

    // Synonym expansion on the full token set (including fuzzy matches)
    if (options?.synonyms === true) {
      const currentTokens = [...tokenKinds.keys()];
      for (const token of currentTokens) {
        const synonyms = SYNONYM_MAP.get(token);
        if (synonyms !== undefined) {
          for (const syn of synonyms) {
            setKind(syn, "synonym");
          }
        }
      }
    }

    // Collect pattern matches with their token-level details
    const patternTokens = new Map<PatternId, Map<string, MatchKind>>();

    for (const [token, kind] of tokenKinds) {
      const set = this.tokenToPatterns.get(token);
      if (set === undefined) continue;
      for (const pid of set) {
        let tmap = patternTokens.get(pid);
        if (tmap === undefined) {
          tmap = new Map();
          patternTokens.set(pid, tmap);
        }
        const existing = tmap.get(token);
        if (existing === undefined || KIND_PRIORITY[kind] < KIND_PRIORITY[existing]) {
          tmap.set(token, kind);
        }
      }
    }

    // Build deterministically sorted results
    const results: SearchMatch[] = [];
    const sortedIds = [...patternTokens.keys()].sort((a, b) => compare(a as string, b as string));

    for (const pid of sortedIds) {
      const tmap = patternTokens.get(pid)!;
      const sortedTokens = [...tmap.keys()].sort(compare);
      const matchKinds: TokenMatch[] = sortedTokens.map((t) => ({
        token: t,
        kind: tmap.get(t)!,
      }));
      results.push({
        patternId: pid,
        matchedTokens: sortedTokens,
        matchKinds,
      });
    }

    return results;
  }
}

// -----------------------------------------------------------------------------
// Token extraction
// -----------------------------------------------------------------------------

function extractTokens(pattern: PatternResult): Set<string> {
  const raw: string[] = [];

  // 1. Name tokens (camelCase split)
  raw.push(...splitCamelCase(pattern.name));

  // 2. File path segments (without extension)
  const pathWithoutExt = pattern.filePath.replace(/\.[^.]+$/, "");
  const segments = pathWithoutExt.replace(/\\/g, "/").split("/");
  for (const segment of segments) {
    raw.push(...splitCamelCase(segment));
  }

  // 3. Metadata string keys and string values
  for (const key of Object.keys(pattern.metadata).sort(compare)) {
    raw.push(...splitCamelCase(key));
    const value = pattern.metadata[key];
    if (typeof value === "string") {
      raw.push(...splitCamelCase(value));
    }
  }

  const tokens = new Set<string>();
  for (const word of raw) {
    const normalized = normalizeToken(word);
    if (normalized.length > 0 && !STOP_WORDS.has(normalized)) {
      tokens.add(normalized);
    }
  }

  return tokens;
}

function splitCamelCase(input: string): string[] {
  return input
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-./]+/)
    .filter((s) => s.length > 0);
}

function normalizeToken(input: string): string {
  return input.toLowerCase().replace(/[^a-z\-_]/g, "");
}

function tokenizeInput(input: string): string[] {
  const raw = splitCamelCase(input);
  const tokens: string[] = [];
  for (const word of raw) {
    const normalized = normalizeToken(word);
    if (normalized.length > 0 && !STOP_WORDS.has(normalized)) {
      tokens.push(normalized);
    }
  }
  return [...new Set(tokens)].sort(compare);
}

// -----------------------------------------------------------------------------
// Edit distance (Levenshtein)
// -----------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Optimisation: early exit when length difference > 1
  if (Math.abs(a.length - b.length) > 1) return 2;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      prev[j] = curr[j]!;
    }
  }

  return prev[b.length]!;
}
