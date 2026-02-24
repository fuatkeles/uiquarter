import { createHash } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import type { OutputHash } from "../types/index.js";

// -----------------------------------------------------------------------------
// Deterministic JSON serialization
// -----------------------------------------------------------------------------

/**
 * Replacer that sorts object keys at every nesting level.
 * Ensures identical data always serializes to identical bytes.
 */
export function stableReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic JSON serialization — keys sorted at every nesting level.
 * Ensures same data always produces byte-identical output.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, stableReplacer, 2) + "\n";
}

// -----------------------------------------------------------------------------
// Atomic file writes
// -----------------------------------------------------------------------------

/**
 * Write a file atomically via temp file + rename.
 *
 * If the process crashes after `writeFile` but before `rename`, the original
 * file is untouched. If it crashes after `rename`, the new content is complete.
 * No intermediate state is ever visible.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // Best effort
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Sorting primitives
// -----------------------------------------------------------------------------

/** Lexicographic string comparison — deterministic, locale-independent. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Return a new object with keys sorted alphabetically. */
export function sortedRecord<V>(obj: Record<string, V>): Record<string, V> {
  const result: Record<string, V> = {};
  for (const key of Object.keys(obj).sort()) {
    result[key] = obj[key]!;
  }
  return result;
}

// -----------------------------------------------------------------------------
// Hashing
// -----------------------------------------------------------------------------

/**
 * Compute the deterministic hash for an empty analyzer output.
 * SHA-256 of `{"patterns":[],"diagnostics":[]}`.
 *
 * Shared across all stub analyzers to avoid duplication.
 */
export function computeEmptyHash(): OutputHash {
  const payload = JSON.stringify({ patterns: [], diagnostics: [] });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
