import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Current schema version. Increment when .uiq/ format changes. */
export const CURRENT_SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface MigrationCheckResult {
  readonly status: "current" | "needs-migration" | "newer-than-tool" | "missing" | "corrupt";
  readonly diskVersion: number | null;
  readonly currentVersion: number;
  readonly message: string;
}

export type MigrationFn = (uiqDir: string) => Promise<void>;

interface MigrationEntry {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: MigrationFn;
}

// -----------------------------------------------------------------------------
// Migration registry
// -----------------------------------------------------------------------------

/**
 * Registered migrations. Each entry upgrades from `fromVersion` to `toVersion`.
 * Add new entries here when the schema changes.
 *
 * Example for future use:
 *   { fromVersion: 1, toVersion: 2, migrate: migrateV1toV2 }
 */
const MIGRATIONS: readonly MigrationEntry[] = [
  // No migrations yet — schema is at version 1.
  // When version 2 is introduced, add:
  // { fromVersion: 1, toVersion: 2, migrate: async (uiqDir) => { ... } },
];

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Check the schema version of an existing .uiq/ directory.
 */
export async function checkSchemaVersion(rootPath: string): Promise<MigrationCheckResult> {
  const uiqDir = join(rootPath, ".uiq");

  // Check if .uiq exists
  try {
    await stat(uiqDir);
  } catch {
    return {
      status: "missing",
      diskVersion: null,
      currentVersion: CURRENT_SCHEMA_VERSION,
      message: "No .uiq directory found.",
    };
  }

  // Read meta.json
  let diskVersion: number;
  try {
    const raw = await readFile(join(uiqDir, "meta.json"), "utf-8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (typeof meta["schemaVersion"] !== "number") {
      return {
        status: "corrupt",
        diskVersion: null,
        currentVersion: CURRENT_SCHEMA_VERSION,
        message: "meta.json missing schemaVersion field.",
      };
    }
    diskVersion = meta["schemaVersion"] as number;
  } catch {
    return {
      status: "corrupt",
      diskVersion: null,
      currentVersion: CURRENT_SCHEMA_VERSION,
      message: "Unable to read .uiq/meta.json.",
    };
  }

  if (diskVersion === CURRENT_SCHEMA_VERSION) {
    return {
      status: "current",
      diskVersion,
      currentVersion: CURRENT_SCHEMA_VERSION,
      message: `Schema version ${diskVersion} is current.`,
    };
  }

  if (diskVersion < CURRENT_SCHEMA_VERSION) {
    return {
      status: "needs-migration",
      diskVersion,
      currentVersion: CURRENT_SCHEMA_VERSION,
      message: `Schema version ${diskVersion} is outdated. Current: ${CURRENT_SCHEMA_VERSION}.`,
    };
  }

  // diskVersion > CURRENT_SCHEMA_VERSION
  return {
    status: "newer-than-tool",
    diskVersion,
    currentVersion: CURRENT_SCHEMA_VERSION,
    message: `Schema version ${diskVersion} is newer than this tool supports (${CURRENT_SCHEMA_VERSION}). Please update UIQuarter.`,
  };
}

/**
 * Run all necessary migrations to bring .uiq/ up to the current schema version.
 * Returns the number of migrations applied.
 */
export async function migrateSchema(rootPath: string): Promise<number> {
  const check = await checkSchemaVersion(rootPath);

  if (check.status === "current") return 0;
  if (check.status === "missing") throw new Error(check.message);
  if (check.status === "corrupt") throw new Error(check.message);
  if (check.status === "newer-than-tool") throw new Error(check.message);

  // Apply migrations in order
  let version = check.diskVersion!;
  let applied = 0;

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((m) => m.fromVersion === version);
    if (migration === undefined) {
      throw new Error(
        `No migration path from schema version ${version} to ${version + 1}.`,
      );
    }

    const uiqDir = join(rootPath, ".uiq");
    await migration.migrate(uiqDir);
    version = migration.toVersion;
    applied++;
  }

  return applied;
}
