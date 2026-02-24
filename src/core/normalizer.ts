import { createHash } from "node:crypto";
import type {
  AnalyzerOutput,
  AnalyzerDiagnostic,
  PatternResult,
  PatternProperty,
  ConfidenceScore,
  ConfidenceFactor,
  OutputHash,
  PatternId,
} from "../types/index.js";
import { compare, sortedRecord, stableReplacer } from "./utils.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface NormalizerOptions {
  /**
   * Maps boolean metadata keys to canonical { category, value } form.
   *
   * When metadata contains `{ tailwind: true }`, the normalizer looks up
   * "tailwind" in this map. If found (e.g., `{ category: "styling", value: "tailwind" }`),
   * it replaces the boolean flag with `{ styling: "tailwind" }`.
   *
   * Keys not in the map are collected into a sorted `flags` array.
   * Keys with `false` values are dropped entirely.
   *
   * Pass an empty record to disable semantic mapping (structural-only mode).
   * Omit to use DEFAULT_METADATA_KEY_MAP.
   */
  metadataKeyMap?: Readonly<Record<string, MetadataMapping>>;
}

export interface MetadataMapping {
  readonly category: string;
  readonly value: string;
}

/**
 * Built-in mappings for well-known libraries and tools.
 * Converts boolean-flag metadata into categorical key-value form.
 *
 * Example: `{ tailwind: true }` → `{ styling: "tailwind" }`
 *
 * Extensible via `NormalizerOptions.metadataKeyMap`.
 */
export const DEFAULT_METADATA_KEY_MAP: Readonly<Record<string, MetadataMapping>> = {
  // CSS / styling
  tailwind:             { category: "styling", value: "tailwind" },
  "tailwind-css":       { category: "styling", value: "tailwind" },
  scss:                 { category: "styling", value: "scss" },
  sass:                 { category: "styling", value: "sass" },
  less:                 { category: "styling", value: "less" },
  "css-modules":        { category: "styling", value: "css-modules" },
  "styled-components":  { category: "styling", value: "styled-components" },
  emotion:              { category: "styling", value: "emotion" },
  "vanilla-extract":    { category: "styling", value: "vanilla-extract" },
  "inline-styles":      { category: "styling", value: "inline-styles" },
  stylex:               { category: "styling", value: "stylex" },

  // State management
  redux:    { category: "stateManagement", value: "redux" },
  zustand:  { category: "stateManagement", value: "zustand" },
  mobx:     { category: "stateManagement", value: "mobx" },
  recoil:   { category: "stateManagement", value: "recoil" },
  jotai:    { category: "stateManagement", value: "jotai" },
  pinia:    { category: "stateManagement", value: "pinia" },
  vuex:     { category: "stateManagement", value: "vuex" },
  ngrx:     { category: "stateManagement", value: "ngrx" },

  // Routing
  "react-router":   { category: "routing", value: "react-router" },
  "vue-router":     { category: "routing", value: "vue-router" },
  "next-router":    { category: "routing", value: "next" },
  "tanstack-router": { category: "routing", value: "tanstack-router" },

  // Data fetching
  "react-query":    { category: "dataFetching", value: "react-query" },
  "tanstack-query": { category: "dataFetching", value: "tanstack-query" },
  swr:              { category: "dataFetching", value: "swr" },
  apollo:           { category: "dataFetching", value: "apollo" },
  trpc:             { category: "dataFetching", value: "trpc" },

  // Form handling
  "react-hook-form": { category: "formLibrary", value: "react-hook-form" },
  formik:            { category: "formLibrary", value: "formik" },
  "vee-validate":    { category: "formLibrary", value: "vee-validate" },

  // Testing
  jest:     { category: "testing", value: "jest" },
  vitest:   { category: "testing", value: "vitest" },
  cypress:  { category: "testing", value: "cypress" },
  playwright: { category: "testing", value: "playwright" },
};

/**
 * Normalize an AnalyzerOutput into canonical form.
 *
 * What this does:
 *
 *   1. DETERMINISTIC ORDERING
 *      - patterns sorted by id
 *      - diagnostics sorted by (filePath, line, column, severity, message)
 *      - PatternResult.dependencies sorted and deduplicated
 *      - ConfidenceScore.factors sorted by name
 *      - metadata keys sorted
 *      - properties keys sorted
 *
 *   2. CANONICAL SCHEMA
 *      - metadata boolean flags → category/value pairs via key map
 *      - unmapped boolean-true flags → collected into sorted `flags` array
 *      - boolean-false entries → dropped (no information content)
 *      - framework names → lowercased and trimmed
 *      - pattern names → trimmed
 *      - file paths → forward slashes
 *      - confidence.value → clamped to [0, 1]
 *
 *   3. HASH RECOMPUTATION
 *      - After normalization, output.hash is recomputed over the
 *        normalized patterns + diagnostics to reflect the canonical content.
 *
 * This function is pure — it returns a new object, never mutates the input.
 */
export function normalizeOutput(
  output: AnalyzerOutput,
  options?: NormalizerOptions,
): AnalyzerOutput {
  const keyMap = options?.metadataKeyMap ?? DEFAULT_METADATA_KEY_MAP;

  const patterns = output.patterns
    .map((p) => normalizePattern(p, keyMap))
    .sort(comparePatterns);

  const diagnostics = [...output.diagnostics].sort(compareDiagnostics);

  const hash = computeOutputHash(patterns, diagnostics);

  return {
    analyzerId: output.analyzerId,
    patterns,
    diagnostics,
    hash,
    duration: output.duration,
    stats: output.stats,
  };
}

// -----------------------------------------------------------------------------
// Pattern normalization
// -----------------------------------------------------------------------------

function normalizePattern(
  p: PatternResult,
  keyMap: Readonly<Record<string, MetadataMapping>>,
): PatternResult {
  return {
    id: p.id,
    type: p.type,
    name: p.name.trim(),
    filePath: p.filePath.replace(/\\/g, "/"),
    location: p.location,
    confidence: normalizeConfidence(p.confidence),
    framework: p.framework.toLowerCase().trim(),
    dependencies: sortedUnique(p.dependencies),
    properties: sortedProperties(p.properties),
    metadata: normalizeMetadata(p.metadata, keyMap),
  };
}

// -----------------------------------------------------------------------------
// Confidence normalization
// -----------------------------------------------------------------------------

function normalizeConfidence(c: ConfidenceScore): ConfidenceScore {
  return {
    value: clamp(c.value, 0, 1),
    source: c.source.trim(),
    factors: [...c.factors]
      .map(normalizeFactor)
      .sort((a, b) => compare(a.name, b.name)),
  };
}

function normalizeFactor(f: ConfidenceFactor): ConfidenceFactor {
  return {
    name: f.name.trim(),
    weight: clamp(f.weight, 0, 1),
    score: clamp(f.score, 0, 1),
  };
}

// -----------------------------------------------------------------------------
// Metadata normalization — the core schema canonicalization
// -----------------------------------------------------------------------------

/**
 * Convert metadata into canonical form:
 *
 *   INPUT:  { tailwind: true, responsive: true, ssr: false, variant: "primary" }
 *   OUTPUT: { flags: ["responsive"], styling: "tailwind", variant: "primary" }
 *
 * Steps:
 *   1. For each entry where value is `true`:
 *      a. If key is in keyMap → use mapped { category: value }
 *      b. Else → add to `flags` array
 *   2. Drop entries where value is `false` (no information)
 *   3. Keep non-boolean entries as-is
 *   4. Sort all keys and the flags array
 */
function normalizeMetadata(
  metadata: Readonly<Record<string, unknown>>,
  keyMap: Readonly<Record<string, MetadataMapping>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const flags: string[] = [];

  for (const key of Object.keys(metadata)) {
    const value = metadata[key];

    if (typeof value === "boolean") {
      if (!value) continue; // drop false — no information content

      const mapping = keyMap[key.toLowerCase()];
      if (mapping) {
        // Semantic mapping: tailwind: true → styling: "tailwind"
        // If the category already has a value (conflict), keep the first one
        // and push the current key to flags as fallback.
        if (result[mapping.category] === undefined) {
          result[mapping.category] = mapping.value;
        } else {
          flags.push(key);
        }
      } else {
        // No mapping — collect as flag
        flags.push(key);
      }
    } else {
      // Non-boolean: keep as-is
      result[key] = value;
    }
  }

  if (flags.length > 0) {
    // Merge with any existing flags array from the original metadata
    const existing = Array.isArray(result["flags"]) ? result["flags"] as string[] : [];
    result["flags"] = sortedUnique([...existing, ...flags] as PatternId[]).map(String);
  }

  // Sort keys for determinism
  return sortedRecord(result);
}

// -----------------------------------------------------------------------------
// Properties normalization
// -----------------------------------------------------------------------------

function sortedProperties(
  props: Readonly<Record<string, PatternProperty>>,
): Readonly<Record<string, PatternProperty>> {
  const result: Record<string, PatternProperty> = {};
  for (const key of Object.keys(props).sort()) {
    const p = props[key]!;
    result[key] = {
      name: p.name.trim(),
      type: p.type.trim(),
      required: p.required,
      ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
    };
  }
  return result;
}

// -----------------------------------------------------------------------------
// Diagnostic sorting
// -----------------------------------------------------------------------------

function compareDiagnostics(
  a: AnalyzerDiagnostic,
  b: AnalyzerDiagnostic,
): number {
  return (
    compare(a.filePath, b.filePath) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compare(a.severity, b.severity) ||
    compare(a.message, b.message)
  );
}

// -----------------------------------------------------------------------------
// Pattern sorting
// -----------------------------------------------------------------------------

function comparePatterns(a: PatternResult, b: PatternResult): number {
  return compare(a.id as string, b.id as string);
}

// -----------------------------------------------------------------------------
// Hash recomputation
// -----------------------------------------------------------------------------

/**
 * Recompute the output hash over normalized patterns + diagnostics.
 * Must exclude timing fields (duration, stats) — same contract as AnalyzerOutput.
 */
function computeOutputHash(
  patterns: readonly PatternResult[],
  diagnostics: readonly AnalyzerDiagnostic[],
): OutputHash {
  const payload = JSON.stringify({ patterns, diagnostics }, stableReplacer);
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

function sortedUnique<T extends string>(arr: readonly T[]): T[] {
  return [...new Set(arr)].sort() as T[];
}
