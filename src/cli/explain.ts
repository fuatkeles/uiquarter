import { resolve } from "node:path";
import { ContextBuilder } from "../context/ContextBuilder.js";
import type { ProjectContext } from "../context/ContextBuilder.js";

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function runExplainCommand(rootPath: string): Promise<void> {
  const builder = new ContextBuilder(resolve(rootPath));
  await builder.load();
  const context = builder.buildProjectContext();

  printSummary(context);
  printHubs(context);
  printChains(context);
  printInsights(context);
}

// -----------------------------------------------------------------------------
// Printers
// -----------------------------------------------------------------------------

function printSummary(context: ProjectContext): void {
  console.log("## Project Summary\n");
  console.log(`Components:     ${context.summary.totalComponents}`);
  console.log(`Insights:       ${context.summary.totalInsights}`);
  console.log(`Hub Components: ${context.summary.hubCount}`);
  console.log(`Deep Chains:    ${context.summary.deepChainCount}`);
}

function printHubs(context: ProjectContext): void {
  if (context.hubs.length === 0) return;

  console.log("\n---\n");
  console.log("Hub Components\n");
  for (const hub of context.hubs) {
    console.log(`  * ${hub.component} (used by ${hub.dependentCount} components)`);
  }
}

function printChains(context: ProjectContext): void {
  if (context.deepChains.length === 0) return;

  console.log("\n---\n");
  console.log("Deep Dependency Chains\n");
  for (const chain of context.deepChains) {
    const path = chain.components.length > 0
      ? chain.components.join(" -> ")
      : `${chain.root} -> ... -> ${chain.leaf}`;
    console.log(`  ${path} (length ${chain.length})`);
  }
}

function printInsights(context: ProjectContext): void {
  if (context.insights.length === 0) return;

  console.log("\n---\n");
  console.log("Insights\n");
  for (const insight of context.insights) {
    console.log(`  [${insight.severity}] ${insight.type} (confidence ${insight.confidence})`);
  }
}
