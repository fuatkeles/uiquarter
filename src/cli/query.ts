import { resolve } from "node:path";
import { QueryEngine } from "../query/QueryEngine.js";
import type { InsightType } from "../types/insight.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const VALID_INSIGHT_TYPES = new Set<string>([
  "hub-component",
  "orphan-component",
  "dependency-cycle",
  "deep-dependency-chain",
  "mixed-styling",
  "architectural-smell",
]);

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function runQueryCommand(
  rootPath: string,
  args: readonly string[],
): Promise<number> {
  const subcommand = args[0];

  if (subcommand === undefined) {
    printUsage();
    return 1;
  }

  const engine = new QueryEngine(resolve(rootPath));

  try {
    await engine.load();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  switch (subcommand) {
    case "stats":
      return cmdStats(engine);
    case "component":
      return cmdComponent(engine, args[1]);
    case "deps":
      return cmdDeps(engine, args[1]);
    case "dependents":
      return cmdDependents(engine, args[1]);
    case "hubs":
      return cmdHubs(engine);
    case "chains":
      return cmdChains(engine);
    case "insights":
      return cmdInsights(engine, args[1]);
    default:
      console.error(`Unknown query command: ${subcommand}\n`);
      printUsage();
      return 1;
  }
}

// -----------------------------------------------------------------------------
// Subcommands
// -----------------------------------------------------------------------------

function cmdStats(engine: QueryEngine): number {
  const stats = engine.getStats();
  console.log(`Total patterns:   ${stats.totalPatterns}`);
  console.log(`Total components: ${stats.totalComponents}`);
  console.log(`Total insights:   ${stats.totalInsights}`);
  return 0;
}

function cmdComponent(engine: QueryEngine, name: string | undefined): number {
  if (name === undefined) {
    console.error("Missing component name.\n");
    printUsage();
    return 1;
  }

  const pattern = engine.findComponent(name);
  if (pattern === null) {
    console.error(`Component not found: ${name}`);
    return 1;
  }

  const deps = engine.findDependencies(name);

  console.log(`Name:         ${pattern.name}`);
  console.log(`Type:         ${pattern.type}`);
  console.log(`File:         ${pattern.filePath}`);
  console.log(`Dependencies: ${deps.length}`);
  return 0;
}

function cmdDeps(engine: QueryEngine, name: string | undefined): number {
  if (name === undefined) {
    console.error("Missing component name.\n");
    printUsage();
    return 1;
  }

  const pattern = engine.findComponent(name);
  if (pattern === null) {
    console.error(`Component not found: ${name}`);
    return 1;
  }

  const deps = engine.findDependencies(name);
  if (deps.length === 0) {
    console.log(`${name} has no dependencies.`);
    return 0;
  }

  console.log(`Dependencies of ${name}:\n`);
  for (const dep of deps) {
    console.log(`  ${dep.name}  ${dep.filePath}`);
  }
  return 0;
}

function cmdDependents(engine: QueryEngine, name: string | undefined): number {
  if (name === undefined) {
    console.error("Missing component name.\n");
    printUsage();
    return 1;
  }

  const pattern = engine.findComponent(name);
  if (pattern === null) {
    console.error(`Component not found: ${name}`);
    return 1;
  }

  const dependents = engine.findDependents(name);
  if (dependents.length === 0) {
    console.log(`${name} has no dependents.`);
    return 0;
  }

  console.log(`Dependents of ${name}:\n`);
  for (const dep of dependents) {
    console.log(`  ${dep.name}  ${dep.filePath}`);
  }
  return 0;
}

function cmdHubs(engine: QueryEngine): number {
  const hubs = engine.findHubComponents();
  if (hubs.length === 0) {
    console.log("No hub components detected.");
    return 0;
  }

  console.log(`Hub components (${hubs.length}):\n`);
  for (const hub of hubs) {
    const name = hub.relatedPatterns.length > 0
      ? String(hub.relatedPatterns[0])
      : hub.id;
    console.log(`  ${name}`);
    console.log(`    Severity:   ${hub.severity}`);
    console.log(`    Confidence: ${hub.confidence}`);
  }
  return 0;
}

function cmdChains(engine: QueryEngine): number {
  const chains = engine.findDeepChains();
  if (chains.length === 0) {
    console.log("No deep dependency chains detected.");
    return 0;
  }

  console.log(`Deep dependency chains (${chains.length}):\n`);
  for (const chain of chains) {
    const depth = typeof chain.metadata["depth"] === "number" ? chain.metadata["depth"] : "?";
    const root = typeof chain.metadata["rootPatternId"] === "string" ? chain.metadata["rootPatternId"] : "?";
    const leaf = typeof chain.metadata["leafPatternId"] === "string" ? chain.metadata["leafPatternId"] : "?";
    console.log(`  Chain length: ${depth}`);
    console.log(`    Root: ${root}`);
    console.log(`    Leaf: ${leaf}`);
  }
  return 0;
}

function cmdInsights(engine: QueryEngine, type: string | undefined): number {
  if (type === undefined) {
    console.error("Missing insight type.\n");
    console.error(`Valid types: ${[...VALID_INSIGHT_TYPES].sort().join(", ")}\n`);
    printUsage();
    return 1;
  }

  if (!VALID_INSIGHT_TYPES.has(type)) {
    console.error(`Unknown insight type: ${type}\n`);
    console.error(`Valid types: ${[...VALID_INSIGHT_TYPES].sort().join(", ")}`);
    return 1;
  }

  const insights = engine.findInsights(type as InsightType);
  if (insights.length === 0) {
    console.log(`No insights of type "${type}".`);
    return 0;
  }

  console.log(`Insights — ${type} (${insights.length}):\n`);
  for (const insight of insights) {
    console.log(`  [${insight.severity}] ${insight.title}`);
    console.log(`    Confidence: ${insight.confidence}`);
    console.log(`    ${insight.description}`);
  }
  return 0;
}

// -----------------------------------------------------------------------------
// Usage
// -----------------------------------------------------------------------------

function printUsage(): void {
  console.log("Usage: uiquarter query <command> [args]\n");
  console.log("Commands:");
  console.log("  stats                    Show project statistics");
  console.log("  component <name>         Show component details");
  console.log("  deps <name>              List component dependencies");
  console.log("  dependents <name>        List component dependents");
  console.log("  hubs                     List hub components");
  console.log("  chains                   List deep dependency chains");
  console.log("  insights <type>          List insights by type");
  console.log("");
  console.log("Examples:");
  console.log("  uiquarter query stats");
  console.log("  uiquarter query component Button");
  console.log("  uiquarter query deps Dashboard");
  console.log("  uiquarter query dependents Button");
  console.log("  uiquarter query hubs");
  console.log("  uiquarter query chains");
  console.log("  uiquarter query insights hub-component");
}
