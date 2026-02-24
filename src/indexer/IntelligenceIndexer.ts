import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AnalyzerOutput,
  PatternResult,
  PatternType,
  DependencyEdge,
  IntelligenceIndex,
  IndexStats,
  PatternId,
  OutputHash,
} from "../types/index.js";
import { atomicWrite, compare, sortedRecord, stableStringify } from "../core/utils.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface IndexerOptions {
  /** Absolute path to the project root. `.uiq/` is created here. */
  readonly rootPath: string;

  /** Tool version written to meta.json. Defaults to "0.1.0". */
  readonly toolVersion?: string;

  /** Schema version for forward-compatibility gating. Defaults to 1. */
  readonly schemaVersion?: number;
}

/** Shape of the on-disk `.uiq/meta.json` file. */
export interface IndexMeta {
  readonly intelligenceHash: string;
  readonly generatedAt: string;
  readonly toolVersion: string;
  readonly schemaVersion: number;
  readonly buildNumber: number;
  readonly compositeHash: string;
  readonly stats: IndexStats;
  readonly analyzerTimings?: Readonly<Record<string, number>>;
}

/**
 * Serializable form of IntelligenceIndex.
 * Maps are converted to sorted plain objects for deterministic JSON.
 */
interface SerializedIndex {
  readonly schemaVersion: number;
  readonly buildNumber: number;
  readonly compositeHash: string;
  readonly entries: Record<string, PatternResult>;
  readonly edges: readonly DependencyEdge[];
  readonly fileIndex: Record<string, readonly string[]>;
  readonly typeIndex: Record<string, readonly string[]>;
  readonly stats: IndexStats;
}

const SCHEMA_VERSION = 1;
const DEFAULT_TOOL_VERSION = "0.1.0";

export interface IndexerDiagnostic {
  readonly severity: "warning" | "error" | "info";
  readonly message: string;
  readonly patternId?: string;
  readonly analyzers?: readonly string[];
  readonly winner?: string;
}

export class IntelligenceIndexer {
  private readonly rootPath: string;
  private readonly toolVersion: string;
  private readonly schemaVersion: number;
  private readonly uiqDir: string;
  private readonly patternsDir: string;

  /** Diagnostics from the most recent build() call. */
  private _buildDiagnostics: readonly IndexerDiagnostic[] = [];

  /** Diagnostics emitted during the last build (duplicate PatternIds, etc.). */
  get buildDiagnostics(): readonly IndexerDiagnostic[] {
    return this._buildDiagnostics;
  }

  constructor(options: IndexerOptions) {
    this.rootPath = options.rootPath;
    this.toolVersion = options.toolVersion ?? DEFAULT_TOOL_VERSION;
    this.schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
    this.uiqDir = join(this.rootPath, ".uiq");
    this.patternsDir = join(this.uiqDir, "patterns");
  }

  // ---------------------------------------------------------------------------
  // build — merge all analyzer outputs into a single IntelligenceIndex
  // ---------------------------------------------------------------------------

  async build(
    outputs: ReadonlyMap<string, AnalyzerOutput>,
  ): Promise<IntelligenceIndex> {
    // 1. Merge patterns in sorted analyzer-name order for determinism
    const entries = new Map<PatternId, PatternResult>();
    const sortedNames = [...outputs.keys()].sort();

    // Track which analyzer contributed each PatternId (for duplicate detection)
    const patternOrigin = new Map<PatternId, string>();
    const diagnostics: IndexerDiagnostic[] = [];

    for (const name of sortedNames) {
      const output = outputs.get(name)!;
      for (const pattern of output.patterns) {
        const previousOwner = patternOrigin.get(pattern.id);
        if (previousOwner !== undefined) {
          // Duplicate detected — last-write-wins (sorted analyzer order)
          diagnostics.push({
            severity: "warning",
            message: "Duplicate PatternId detected",
            patternId: pattern.id as string,
            analyzers: [previousOwner, name].sort(),
            winner: name,
          });
        }
        patternOrigin.set(pattern.id, name);
        entries.set(pattern.id, pattern);
      }
    }

    // Sort diagnostics for determinism
    diagnostics.sort((a, b) => compare(a.patternId ?? "", b.patternId ?? ""));
    this._buildDiagnostics = diagnostics;

    // 2. Build dependency edges from pattern dependencies
    const edges = buildEdges(entries);

    // 3. Build file index: filePath → PatternId[]
    const fileIndex = buildFileIndex(entries);

    // 4. Build type index: PatternType → PatternId[]
    const typeIndex = buildTypeIndex(entries);

    // 5. Compute composite hash
    const compositeHash = computeCompositeHash(outputs, sortedNames);

    // 6. Compute stats
    const stats = computeStats(entries, edges);

    // 7. Load previous build number
    const prevBuildNumber = await this.loadPreviousBuildNumber();

    return {
      schemaVersion: this.schemaVersion,
      buildNumber: prevBuildNumber + 1,
      compositeHash,
      entries,
      edges,
      fileIndex,
      typeIndex,
      stats,
    };
  }

  // ---------------------------------------------------------------------------
  // write — persist IntelligenceIndex to disk
  // ---------------------------------------------------------------------------

  async write(
    index: IntelligenceIndex,
    writeOptions?: { analyzerTimings?: Readonly<Record<string, number>> },
  ): Promise<void> {
    await mkdir(this.patternsDir, { recursive: true });

    // 1. Write individual pattern files (new + updated)
    const writtenFileNames = await this.writePatternFiles(index.entries);

    // 2. Remove orphan pattern files (from previous builds)
    await this.removeOrphanPatterns(writtenFileNames);

    // 3. Serialize index to JSON
    const serialized = serializeIndex(index);
    const indexJson = stableStringify(serialized);

    // 4. Write index.json atomically
    await atomicWrite(join(this.uiqDir, "index.json"), indexJson);

    // 5. Compute intelligence hash from index.json content
    const intelligenceHash = createHash("sha256")
      .update(indexJson)
      .digest("hex");

    // 6. Write meta.json atomically
    const meta: IndexMeta = {
      intelligenceHash,
      generatedAt: new Date().toISOString(),
      toolVersion: this.toolVersion,
      schemaVersion: this.schemaVersion,
      buildNumber: index.buildNumber,
      compositeHash: index.compositeHash as string,
      stats: index.stats,
      ...(writeOptions?.analyzerTimings !== undefined
        ? { analyzerTimings: writeOptions.analyzerTimings }
        : {}),
    };

    await atomicWrite(join(this.uiqDir, "meta.json"), stableStringify(meta));
  }

  // ---------------------------------------------------------------------------
  // buildAndWrite — convenience
  // ---------------------------------------------------------------------------

  async buildAndWrite(
    outputs: ReadonlyMap<string, AnalyzerOutput>,
    writeOptions?: { analyzerTimings?: Readonly<Record<string, number>> },
  ): Promise<IntelligenceIndex> {
    const index = await this.build(outputs);
    await this.write(index, writeOptions);
    return index;
  }

  // ---------------------------------------------------------------------------
  // Private: pattern file writing
  // ---------------------------------------------------------------------------

  private async writePatternFiles(
    entries: ReadonlyMap<PatternId, PatternResult>,
  ): Promise<Set<string>> {
    const writtenFileNames = new Set<string>();
    const sortedIds = [...entries.keys()].sort();
    for (const id of sortedIds) {
      const pattern = entries.get(id)!;
      const fileName = sanitizePatternId(id) + ".json";
      const filePath = join(this.patternsDir, fileName);
      await atomicWrite(filePath, stableStringify(pattern));
      writtenFileNames.add(fileName);
    }
    return writtenFileNames;
  }

  /**
   * Remove pattern files that were written by a previous build but are
   * no longer present in the current build.
   *
   * Safety: this runs AFTER all new pattern files have been successfully
   * written, so a crash during cleanup leaves extra files (safe) rather
   * than missing files (dangerous).
   */
  private async removeOrphanPatterns(
    currentFileNames: ReadonlySet<string>,
  ): Promise<void> {
    let existing: string[];
    try {
      existing = await readdir(this.patternsDir);
    } catch {
      return; // Directory doesn't exist or can't be read — nothing to clean
    }

    // Sort for deterministic deletion order
    const orphans = existing
      .filter((f) => f.endsWith(".json") && !currentFileNames.has(f))
      .sort();

    for (const orphan of orphans) {
      await rm(join(this.patternsDir, orphan), { force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: build number persistence
  // ---------------------------------------------------------------------------

  private async loadPreviousBuildNumber(): Promise<number> {
    try {
      const raw = await readFile(join(this.uiqDir, "meta.json"), "utf-8");
      const meta = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof meta["buildNumber"] === "number" &&
        Number.isFinite(meta["buildNumber"])
      ) {
        return meta["buildNumber"] as number;
      }
      return 0;
    } catch {
      return 0; // First build or corrupted meta
    }
  }
}

// -----------------------------------------------------------------------------
// Edge building
// -----------------------------------------------------------------------------

function buildEdges(
  entries: ReadonlyMap<PatternId, PatternResult>,
): readonly DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  // Sorted iteration for determinism
  const sortedIds = [...entries.keys()].sort();

  for (const id of sortedIds) {
    const pattern = entries.get(id)!;

    // Build lookup from metadata.edges if present (DependencyAnalyzer stores typed edge kinds there)
    const metaEdges = Array.isArray(pattern.metadata?.edges)
      ? pattern.metadata.edges as readonly { target: string; kind: string }[]
      : undefined;

    const kindByTarget = new Map<string, DependencyEdge["kind"]>();
    if (metaEdges) {
      for (const me of metaEdges) {
        if (typeof me.target === "string" && typeof me.kind === "string") {
          kindByTarget.set(me.target, me.kind as DependencyEdge["kind"]);
        }
      }
    }

    for (const depId of pattern.dependencies) {
      edges.push({
        from: id,
        to: depId,
        kind: kindByTarget.get(depId as string) ?? "import",
      });
    }
  }

  // Sort edges for determinism: (from, to, kind)
  edges.sort((a, b) =>
    compare(a.from as string, b.from as string) ||
    compare(a.to as string, b.to as string) ||
    compare(a.kind, b.kind),
  );

  return edges;
}

// -----------------------------------------------------------------------------
// Index building
// -----------------------------------------------------------------------------

function buildFileIndex(
  entries: ReadonlyMap<PatternId, PatternResult>,
): ReadonlyMap<string, readonly PatternId[]> {
  const map = new Map<string, PatternId[]>();

  for (const [id, pattern] of entries) {
    let arr = map.get(pattern.filePath);
    if (!arr) {
      arr = [];
      map.set(pattern.filePath, arr);
    }
    arr.push(id);
  }

  // Sort IDs within each file group
  for (const arr of map.values()) {
    arr.sort();
  }

  // Sort map by file path for deterministic iteration
  return new Map([...map.entries()].sort((a, b) => compare(a[0], b[0])));
}

function buildTypeIndex(
  entries: ReadonlyMap<PatternId, PatternResult>,
): ReadonlyMap<PatternType, readonly PatternId[]> {
  const map = new Map<PatternType, PatternId[]>();

  for (const [id, pattern] of entries) {
    let arr = map.get(pattern.type);
    if (!arr) {
      arr = [];
      map.set(pattern.type, arr);
    }
    arr.push(id);
  }

  // Sort IDs within each type group
  for (const arr of map.values()) {
    arr.sort();
  }

  // Sort map by type for deterministic iteration
  return new Map([...map.entries()].sort((a, b) => compare(a[0], b[0])));
}

// -----------------------------------------------------------------------------
// Composite hash — changes only when actual pattern content changes
// -----------------------------------------------------------------------------

/**
 * Deterministic composite hash over all analyzer output hashes.
 *
 * Strategy:
 *   1. Collect each output's hash, keyed by sorted analyzer name
 *   2. Join with "|" delimiter
 *   3. SHA-256 the joined string
 *
 * This means the compositeHash changes if and only if at least one
 * analyzer's output hash changes — i.e., actual pattern/diagnostic
 * content changed. Timing fields (duration, stats) are excluded
 * because individual output hashes already exclude them.
 *
 * Empty input → SHA-256("") as a well-defined sentinel.
 */
function computeCompositeHash(
  outputs: ReadonlyMap<string, AnalyzerOutput>,
  sortedNames: readonly string[],
): OutputHash {
  const parts: string[] = [];
  for (const name of sortedNames) {
    parts.push(outputs.get(name)!.hash as string);
  }
  const payload = parts.join("|");
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}

// -----------------------------------------------------------------------------
// Stats computation
// -----------------------------------------------------------------------------

function computeStats(
  entries: ReadonlyMap<PatternId, PatternResult>,
  edges: readonly DependencyEdge[],
): IndexStats {
  const files = new Set<string>();
  const byFramework: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const pattern of entries.values()) {
    files.add(pattern.filePath);

    const fw = pattern.framework;
    byFramework[fw] = (byFramework[fw] ?? 0) + 1;

    const t = pattern.type;
    byType[t] = (byType[t] ?? 0) + 1;
  }

  return {
    totalPatterns: entries.size,
    totalEdges: edges.length,
    totalFiles: files.size,
    byFramework: sortedRecord(byFramework),
    byType: sortedRecord(byType),
  };
}

// -----------------------------------------------------------------------------
// Serialization — convert Maps to sorted plain objects
// -----------------------------------------------------------------------------

function serializeIndex(index: IntelligenceIndex): SerializedIndex {
  // entries: Map → sorted Record
  const entries: Record<string, PatternResult> = {};
  for (const id of [...index.entries.keys()].sort()) {
    entries[id as string] = index.entries.get(id)!;
  }

  // fileIndex: Map → sorted Record
  const fileIndex: Record<string, readonly string[]> = {};
  for (const path of [...index.fileIndex.keys()].sort()) {
    fileIndex[path] = index.fileIndex.get(path)!;
  }

  // typeIndex: Map → sorted Record
  const typeIndex: Record<string, readonly string[]> = {};
  for (const type of [...index.typeIndex.keys()].sort()) {
    typeIndex[type] = index.typeIndex.get(type)!;
  }

  return {
    schemaVersion: index.schemaVersion,
    buildNumber: index.buildNumber,
    compositeHash: index.compositeHash as string,
    entries,
    edges: index.edges,
    fileIndex,
    typeIndex,
    stats: index.stats,
  };
}

// -----------------------------------------------------------------------------
// File system helpers
// -----------------------------------------------------------------------------

/**
 * Convert a PatternId to a safe filesystem name.
 *
 * PatternId format: `${filePath}:${name}:${line}`
 * Characters unsafe for filenames: `:`, `/`, `\`
 *
 * Strategy: replace / and \ with `_`, : with `__`
 * This is injective for practical PatternId values.
 */
function sanitizePatternId(id: PatternId): string {
  return (id as string)
    .replace(/[/\\]/g, "_")
    .replace(/:/g, "__");
}

