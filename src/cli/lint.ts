import { resolve, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  ConventionChecker,
  formatViolationsText,
  formatViolationsMarkdown,
  formatViolationsJson,
} from "../conventions/ConventionChecker.js";
import type { IntelligenceIndex, Insight } from "../types/index.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface LintCommandOptions {
  readonly dir?: string;
  readonly format?: string;
  readonly output?: string;
}

// -----------------------------------------------------------------------------
// Command runner
// -----------------------------------------------------------------------------

export async function runLintCommand(options: LintCommandOptions): Promise<number> {
  const rootPath = resolve(options.dir ?? process.cwd());
  const uiqDir = join(rootPath, ".uiq");
  const format = (options.format ?? "text") as "text" | "md" | "json";

  // Load index
  let index: IntelligenceIndex;
  try {
    const raw = await readFile(join(uiqDir, "index.json"), "utf-8");
    index = JSON.parse(raw) as IntelligenceIndex;
  } catch {
    throw new Error("UIQuarter analysis not found. Run 'uiquarter init' first.");
  }

  // Load insights
  let insights: Insight[] = [];
  try {
    const raw = await readFile(join(uiqDir, "insights.json"), "utf-8");
    const parsed = JSON.parse(raw) as { insights?: Insight[] };
    insights = parsed.insights ?? [];
  } catch {
    // No insights file — proceed with empty list
  }

  // Run checker
  const checker = new ConventionChecker(rootPath);
  const result = await checker.check(index, insights);

  // Format output
  let output: string;
  switch (format) {
    case "md":
      output = formatViolationsMarkdown(result);
      break;
    case "json":
      output = formatViolationsJson(result);
      break;
    default:
      output = formatViolationsText(result);
      break;
  }

  if (options.output) {
    await writeFile(options.output, output, "utf-8");
  } else {
    process.stdout.write(output);
  }

  // Exit code: 1 if any error-severity violations
  const hasErrors = result.violations.some((v) => v.severity === "error");
  return hasErrors ? 1 : 0;
}
