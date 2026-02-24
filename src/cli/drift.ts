import { resolve as resolvePath, join } from "node:path";
import { readFile, writeFile, stat } from "node:fs/promises";
import {
  loadSnapshot,
  computeDrift,
  formatDriftText,
  formatDriftMarkdown,
  formatDriftJson,
} from "../drift/DriftDetector.js";
import type { DriftSnapshot } from "../drift/DriftDetector.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface DriftCommandOptions {
  readonly dir?: string;
  readonly format?: "text" | "md" | "json";
  readonly save?: boolean;
  readonly compare?: string;   // Branch name for comparison
}

// -----------------------------------------------------------------------------
// Snapshot persistence
// -----------------------------------------------------------------------------

const SNAPSHOT_FILE = "snapshot.json";

async function loadSavedSnapshot(uiqDir: string): Promise<DriftSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(join(uiqDir, SNAPSHOT_FILE), "utf-8");
  } catch {
    // File does not exist — no saved baseline
    return null;
  }
  try {
    return JSON.parse(raw) as DriftSnapshot;
  } catch {
    throw new Error(`Baseline snapshot at .uiq/${SNAPSHOT_FILE} is corrupt. Run 'uiquarter drift --save' to recapture.`);
  }
}

async function saveSnapshot(uiqDir: string, snapshot: DriftSnapshot): Promise<void> {
  await writeFile(join(uiqDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2), "utf-8");
}

// -----------------------------------------------------------------------------
// Command handler
// -----------------------------------------------------------------------------

export async function runDriftCommand(options: DriftCommandOptions): Promise<void> {
  const rootPath = resolvePath(options.dir ?? process.cwd());
  const uiqDir = join(rootPath, ".uiq");

  // Check .uiq exists
  try {
    await stat(uiqDir);
  } catch {
    throw new Error("No .uiq directory found. Run 'uiquarter init' first.");
  }

  const format = options.format ?? "text";

  // --save: take a snapshot of current state as baseline
  if (options.save === true) {
    const current = await loadSnapshot(uiqDir);
    await saveSnapshot(uiqDir, current);
    console.log(`Snapshot saved (build #${current.meta.buildNumber}).`);
    return;
  }

  // --compare: compare against a branch
  if (options.compare !== undefined) {
    const { compareBranches } = await import("../drift/BranchDiff.js");
    const result = await compareBranches({
      rootPath,
      targetBranch: options.compare,
      format,
    });
    process.stdout.write(result.report + "\n");
    return;
  }

  // Load saved baseline
  const saved = await loadSavedSnapshot(uiqDir);
  if (saved === null) {
    throw new Error("No baseline snapshot found. Run 'uiquarter drift --save' first to capture a baseline.");
  }

  // Load current state
  const current = await loadSnapshot(uiqDir);

  // Compute drift
  const report = computeDrift(saved, current);

  // Format output
  let output: string;
  switch (format) {
    case "json":
      output = formatDriftJson(report);
      break;
    case "md":
      output = formatDriftMarkdown(report);
      break;
    default:
      output = formatDriftText(report);
      break;
  }

  process.stdout.write(output + "\n");
}
