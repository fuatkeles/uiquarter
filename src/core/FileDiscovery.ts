import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { Dirent } from "node:fs";
import ignore, { type Ignore } from "ignore";
import type { DiscoveredFile, FileHash } from "../types/index.js";

/**
 * Directories always excluded regardless of .uiqignore content.
 * These are never useful for UI component analysis and skipping
 * them early avoids millions of unnecessary readdir calls.
 */
const ALWAYS_IGNORED = [
  "node_modules",
  ".git",
];

/**
 * Directories excluded by default but overridable via .uiqignore negation.
 * A user can write `!dist/` in .uiqignore to re-include dist.
 */
const DEFAULT_IGNORED = [
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
];

/** Concurrency limit for parallel file I/O (hashing + stat) */
const DEFAULT_CONCURRENCY = 64;

export interface FileDiscoveryOptions {
  /** Absolute path to the project root */
  rootPath: string;

  /** Ignore file name. Defaults to ".uiqignore". */
  ignoreFilename?: string;

  /** Extra patterns to ignore on top of defaults */
  additionalIgnores?: string[];

  /** Max parallel file reads. Defaults to 64. */
  concurrency?: number;

  /** When true, log skipped files/dirs to stderr. Defaults to false. */
  debug?: boolean;
}

/**
 * FileDiscovery — scans a project directory and returns a deterministic,
 * stable list of DiscoveredFile objects.
 *
 * Design:
 *   Phase 1: Walk the directory tree, collecting paths. Ignored directories
 *            are pruned at this phase so we never recurse into them.
 *   Phase 2: Read + hash files with bounded concurrency. This is the I/O
 *            heavy phase and the concurrency limit prevents fd exhaustion.
 *   Phase 3: Sort by relativePath (simple string compare, not locale-aware)
 *            for deterministic output across platforms and locales.
 *
 * Guarantees:
 *   - Same file tree → same output (deterministic ordering + stable hashes)
 *   - Symlinks are skipped (avoids cycles and platform inconsistencies)
 *   - Unreadable files are skipped silently (permission errors, etc.)
 *   - ALWAYS_IGNORED dirs are never entered (hardcoded, not overridable)
 *   - DEFAULT_IGNORED dirs can be re-included via .uiqignore negation
 */
export class FileDiscovery {
  private readonly rootPath: string;
  private readonly ignoreFilename: string;
  private readonly additionalIgnores: string[];
  private readonly concurrency: number;
  private readonly debug: boolean;

  constructor(options: FileDiscoveryOptions) {
    this.rootPath = options.rootPath;
    this.ignoreFilename = options.ignoreFilename ?? ".uiqignore";
    this.additionalIgnores = options.additionalIgnores ?? [];
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.debug = options.debug ?? false;
  }

  private debugLog(reason: string, path: string): void {
    if (this.debug) {
      process.stderr.write(`[FileDiscovery] skip (${reason}): ${path}\n`);
    }
  }

  async discover(): Promise<DiscoveredFile[]> {
    const ig = await this.loadIgnoreRules();

    // Phase 1: collect all candidate file paths
    const candidates: FilePath[] = [];
    await this.walkDirectory(this.rootPath, ig, candidates);

    // Phase 2: read + hash with bounded concurrency
    const files = await this.processFiles(candidates);

    // Phase 3: deterministic sort — simple codepoint comparison, no locale
    files.sort((a, b) =>
      a.relativePath < b.relativePath ? -1
        : a.relativePath > b.relativePath ? 1
          : 0,
    );

    return files;
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — directory walk
  // ---------------------------------------------------------------------------

  private async loadIgnoreRules(): Promise<Ignore> {
    const ig = ignore().add(DEFAULT_IGNORED).add(this.additionalIgnores);

    try {
      const raw = await readFile(
        join(this.rootPath, this.ignoreFilename),
        "utf-8",
      );
      ig.add(raw);
    } catch {
      // No ignore file — defaults only
    }

    return ig;
  }

  private async walkDirectory(
    dirPath: string,
    ig: Ignore,
    out: FilePath[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      // Permission denied or deleted mid-scan — skip silently
      return;
    }

    const subdirs: Promise<void>[] = [];

    for (const entry of entries) {
      // Normalize to forward slashes for cross-platform determinism.
      // The `ignore` package and all downstream consumers expect posix paths.
      const rel = relative(this.rootPath, join(dirPath, entry.name)).replace(
        /\\/g,
        "/",
      );

      if (entry.isSymbolicLink()) {
        this.debugLog("symlink", rel);
        continue;
      }

      if (entry.isDirectory()) {
        // Hardcoded prune — never recurse
        if (ALWAYS_IGNORED.includes(entry.name)) {
          this.debugLog("always-ignored", rel);
          continue;
        }

        // Soft prune — check against ignore rules (dir trailing slash)
        if (ig.ignores(rel + "/")) {
          this.debugLog("ignore-rule", rel + "/");
          continue;
        }

        subdirs.push(this.walkDirectory(join(dirPath, entry.name), ig, out));
      } else if (entry.isFile()) {
        if (ig.ignores(rel)) {
          this.debugLog("ignore-rule", rel);
          continue;
        }
        out.push({ absolute: join(dirPath, entry.name), relative: rel });
      } else {
        this.debugLog("non-file", rel);
      }
    }

    await Promise.all(subdirs);
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — parallel file processing
  // ---------------------------------------------------------------------------

  private async processFiles(paths: FilePath[]): Promise<DiscoveredFile[]> {
    const results: DiscoveredFile[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        // cursor++ is atomic in single-threaded JS — no two workers
        // will ever process the same index.
        const idx = cursor++;
        const entry = paths[idx]!;
        const file = await this.buildFile(entry.absolute, entry.relative);
        if (file !== null) {
          results.push(file);
        }
      }
    };

    const workerCount = Math.min(this.concurrency, paths.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
  }

  private async buildFile(
    absolutePath: string,
    relativePath: string,
  ): Promise<DiscoveredFile | null> {
    try {
      // Parallel I/O: read content (for hash) + stat (for metadata)
      const [content, fileStat] = await Promise.all([
        readFile(absolutePath),
        lstat(absolutePath),
      ]);

      // Hash = SHA-256(relativePath + content)
      // Using relativePath in the hash means identical files at different
      // locations produce different hashes, which is correct for cache
      // invalidation — moving a file must bust its cache entry.
      const hash = createHash("sha256")
        .update(relativePath)
        .update(content)
        .digest("hex") as FileHash;

      const ext = extname(absolutePath);

      return {
        absolutePath,
        relativePath,
        hash,
        size: content.length,
        extension: ext.startsWith(".") ? ext.slice(1) : ext,
        lastModified: fileStat.mtimeMs,
      };
    } catch {
      this.debugLog("read-error", relativePath);
      return null;
    }
  }
}

/** Internal path tuple used between Phase 1 and Phase 2 */
interface FilePath {
  absolute: string;
  relative: string;
}
