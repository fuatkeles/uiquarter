import { resolve, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { QueryEngine } from "../query/QueryEngine.js";
import { generateHtmlReport } from "../report/HtmlReporter.js";
import type { ReportData } from "../report/HtmlReporter.js";

export interface ReportCommandOptions {
  readonly dir?: string;
  readonly output?: string;
  readonly open?: boolean;
}

export async function runReportCommand(options: ReportCommandOptions): Promise<void> {
  const rootPath = resolve(options.dir ?? process.cwd());
  const outputPath = options.output ?? join(rootPath, "uiquarter-report.html");

  // Load context
  const contextBuilder = new ContextBuilder(rootPath);
  try {
    await contextBuilder.load();
  } catch {
    throw new Error("UIQuarter analysis not found. Run 'uiquarter init' first.");
  }

  const project = contextBuilder.buildProjectContext();

  // Try to load UX coverage from index
  let uxCoverage: ReportData["uxCoverage"] = undefined;
  try {
    const engine = new QueryEngine(rootPath);
    await engine.load();
    const uxSummary = engine.findComponent("ux-summary");
    if (uxSummary) {
      uxCoverage = {
        accessibility: Number(uxSummary.metadata["accessibilityCoverage"] ?? 0),
        errorState: Number(uxSummary.metadata["errorStateCoverage"] ?? 0),
        loadingState: Number(uxSummary.metadata["loadingStateCoverage"] ?? 0),
        responsive: Number(uxSummary.metadata["responsiveCoverage"] ?? 0),
      };
    }
  } catch {}

  const data: ReportData = {
    project,
    generatedAt: new Date().toISOString(),
    uxCoverage,
  };

  const html = generateHtmlReport(data);
  await writeFile(outputPath, html, "utf-8");

  console.log(`Report written to ${outputPath} (${html.length} chars)`);

  // Open in browser if requested
  if (options.open) {
    try {
      const platform = process.platform;
      if (platform === "darwin") execSync(`open "${outputPath}"`);
      else if (platform === "win32") execSync(`start "" "${outputPath}"`);
      else execSync(`xdg-open "${outputPath}"`);
    } catch {
      console.log("Could not open browser automatically.");
    }
  }
}
