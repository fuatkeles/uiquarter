import type { FileHash } from "./brand.js";

/** A file discovered during the scan phase, before any analysis. */
export interface DiscoveredFile {
  /** Absolute path on disk */
  readonly absolutePath: string;

  /** Path relative to the project root — used in all output and cache keys */
  readonly relativePath: string;

  /** Content hash (SHA-256). Compared against cache to skip re-analysis. */
  readonly hash: FileHash;

  /** File size in bytes — cheap pre-filter for analyzers */
  readonly size: number;

  /** Extension without the dot: "tsx", "vue", "svelte" */
  readonly extension: string;

  /** Last modification epoch ms — used as tiebreaker, never as cache key */
  readonly lastModified: number;
}

/** Source location within a file */
export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

/** A span from start to end within a single file */
export interface SourceSpan {
  readonly file: string;
  readonly start: SourceLocation;
  readonly end: SourceLocation;
}
