import { resolve } from "node:path";
import { generateCiReport, generateGithubActionTemplate, postPrComment } from "../ci/index.js";
import type { CiFailLevel } from "../ci/index.js";
import { loadSnapshot, computeDrift, type DriftSnapshot } from "../drift/DriftDetector.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CiCommandOptions {
  readonly dir?: string;
  readonly failOn?: string; // "error" | "warning" | "info" | "none"
  readonly format?: string; // "text" | "md" | "json"
  readonly output?: string; // file path
  readonly pr?: string; // PR number
  readonly repo?: string; // owner/repo
  readonly update?: boolean;
  readonly template?: boolean; // print GitHub Action template
}

// -----------------------------------------------------------------------------
// Command runner
// -----------------------------------------------------------------------------

export async function runCiCommand(options: CiCommandOptions): Promise<number> {
  if (options.template) {
    process.stdout.write(generateGithubActionTemplate());
    return 0;
  }

  const rootPath = resolve(options.dir ?? process.cwd());
  const uiqDir = join(rootPath, ".uiq");
  const format = (options.format ?? "md") as "text" | "md" | "json";
  const failOn = (options.failOn ?? "error") as CiFailLevel;

  // Load current snapshot
  let currentSnapshot: DriftSnapshot;
  try {
    currentSnapshot = await loadSnapshot(uiqDir);
  } catch {
    throw new Error("UIQuarter analysis not found. Run 'uiquarter init' first.");
  }

  // Load current insights
  let currentInsights: Array<{
    id: string;
    category: string;
    severity: string;
    title: string;
    description: string;
  }> = [];
  try {
    const insightsRaw = await readFile(join(uiqDir, "insights.json"), "utf-8");
    const parsed = JSON.parse(insightsRaw) as { insights?: readonly any[] };
    if (Array.isArray(parsed.insights)) {
      currentInsights = parsed.insights.map((i: any) => ({
        id: String(i.id ?? ""),
        category: String(i.category ?? ""),
        severity: String(i.severity ?? "info"),
        title: String(i.title ?? ""),
        description: String(i.description ?? ""),
      }));
    }
  } catch {
    // No insights file — proceed with empty list
  }

  // Load baseline if exists
  let drift = null;
  try {
    const baselineRaw = await readFile(
      join(uiqDir, "snapshots", "baseline.json"),
      "utf-8",
    );
    const baseline = JSON.parse(baselineRaw) as DriftSnapshot;
    drift = computeDrift(baseline, currentSnapshot);
  } catch {
    // No baseline — report current state only
  }

  // Generate report
  const result = generateCiReport(drift, currentInsights, { format, failOn });

  // Output
  if (options.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(options.output, result.output, "utf-8");
  } else {
    process.stdout.write(result.output);
  }

  // Post PR comment if requested
  if (options.pr && options.repo) {
    await postPrComment({
      repo: options.repo,
      prNumber: Number(options.pr),
      body: result.output,
      update: options.update,
    });
  }

  return result.exitCode;
}
