import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  loadSnapshot,
  computeDrift,
  formatDriftText,
  formatDriftMarkdown,
  formatDriftJson,
} from "./DriftDetector.js";
import type { DriftReport } from "./DriftDetector.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface BranchDiffOptions {
  readonly rootPath: string;
  readonly targetBranch: string;
  readonly format: "text" | "md" | "json";
}

export interface BranchDiffResult {
  readonly report: string;
  readonly drift: DriftReport;
}

// -----------------------------------------------------------------------------
// Git helpers
// -----------------------------------------------------------------------------

function isGitRepo(rootPath: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: rootPath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function getCurrentBranch(rootPath: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: rootPath,
    encoding: "utf-8",
  }).trim();
}

function branchExists(rootPath: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify ${branch}`, {
      cwd: rootPath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Branch comparison
// -----------------------------------------------------------------------------

export async function compareBranches(
  options: BranchDiffOptions,
): Promise<BranchDiffResult> {
  if (!isGitRepo(options.rootPath)) {
    throw new Error("Not a git repository. Branch comparison requires git.");
  }

  if (!branchExists(options.rootPath, options.targetBranch)) {
    throw new Error(`Branch '${options.targetBranch}' not found.`);
  }

  const currentBranch = getCurrentBranch(options.rootPath);
  const uiqDir = join(options.rootPath, ".uiq");

  // Load current snapshot
  const currentSnapshot = await loadSnapshot(uiqDir);

  // Create temp worktree for target branch
  const sanitizedBranch = options.targetBranch.replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const worktreePath = join(
    options.rootPath,
    ".uiq",
    "worktrees",
    sanitizedBranch,
  );

  try {
    execSync(`git worktree add "${worktreePath}" ${options.targetBranch}`, {
      cwd: options.rootPath,
      stdio: "ignore",
    });
  } catch (err) {
    throw new Error(
      `Failed to create worktree for '${options.targetBranch}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    // Run init in worktree to generate .uiq/
    const cliPath = join(options.rootPath, "dist", "cli.js");
    try {
      execSync(`node "${cliPath}" init -d "${worktreePath}"`, {
        stdio: "ignore",
      });
    } catch {
      throw new Error(
        `Failed to run 'uiquarter init' in worktree for '${options.targetBranch}'.`,
      );
    }

    // Load target snapshot
    const targetUiqDir = join(worktreePath, ".uiq");
    const targetSnapshot = await loadSnapshot(targetUiqDir);

    // Compute drift (target -> current, so "added" means new in current branch)
    const drift = computeDrift(targetSnapshot, currentSnapshot);

    // Format report
    let report: string;
    switch (options.format) {
      case "md":
        report = formatDriftMarkdown(drift);
        break;
      case "json":
        report = formatDriftJson(drift);
        break;
      default:
        report = formatDriftText(drift);
        break;
    }

    // Add branch context header
    const header =
      options.format === "md"
        ? `# Branch Comparison: ${options.targetBranch} → ${currentBranch}\n\n`
        : options.format === "json"
          ? "" // JSON doesn't need header
          : `Branch Comparison: ${options.targetBranch} → ${currentBranch}\n${"=".repeat(50)}\n\n`;

    return {
      report: header + report,
      drift,
    };
  } finally {
    // Cleanup worktree
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: options.rootPath,
        stdio: "ignore",
      });
    } catch {
      // Best effort cleanup
    }
  }
}
