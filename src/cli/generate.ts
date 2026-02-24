import { resolve as resolvePath, join, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { QueryEngine } from "../query/QueryEngine.js";
import { getTargetConfig, getAllTargetNames } from "../generate/registry.js";
import type {
  GenerateTargetName,
  GenerateCommandOptions,
  GeneratorContext,
  ConventionContext,
} from "../generate/types.js";

// -----------------------------------------------------------------------------
// Conventions extraction from QueryEngine
// -----------------------------------------------------------------------------

function extractConventions(engine: QueryEngine): ConventionContext | null {
  const pattern = engine.findComponent("conventions");
  if (pattern === null) return null;

  const m = pattern.metadata;
  return {
    dominantFileNaming: String(m["dominantFileNaming"] ?? "unknown"),
    dominantDirNaming: String(m["dominantDirNaming"] ?? "unknown"),
    testStrategy: String(m["testStrategy"] ?? "unknown"),
    styleStrategy: String(m["styleStrategy"] ?? "unknown"),
    barrelCount: Number(m["barrelCount"] ?? 0),
    componentDirCount: Number(m["componentDirCount"] ?? 0),
    totalDirectories: Number(m["totalDirectories"] ?? 0),
    totalFiles: Number(m["totalFiles"] ?? 0),
  };
}

// -----------------------------------------------------------------------------
// Command handler
// -----------------------------------------------------------------------------

export async function runGenerateCommand(options: GenerateCommandOptions): Promise<void> {
  const rootPath = resolvePath(options.dir ?? process.cwd());

  // Load context
  const builder = new ContextBuilder(rootPath);
  try {
    await builder.load();
  } catch {
    throw new Error("UIQuarter analysis not found. Run 'uiquarter init' first.");
  }
  const project = builder.buildProjectContext();

  // Load conventions from QueryEngine
  const engine = new QueryEngine(rootPath);
  try {
    await engine.load();
  } catch {
    throw new Error("UIQuarter index not found. Run 'uiquarter init' first.");
  }
  const conventions = extractConventions(engine);

  const ctx: GeneratorContext = { project, conventions };

  // Determine targets
  const targetNames: readonly GenerateTargetName[] =
    options.target === "all"
      ? getAllTargetNames()
      : [options.target];

  // Generate
  const writes: Promise<void>[] = [];

  for (const targetName of targetNames) {
    const config = getTargetConfig(targetName);
    const files = config.formatter(ctx, {
      charBudget: config.defaultCharBudget,
    });

    for (const file of files) {
      const fullPath = join(rootPath, file.relativePath);

      if (options.dryRun === true) {
        console.log(`[dry-run] ${file.relativePath} (${file.content.length} chars)`);
      } else {
        writes.push(writeGeneratedFile(fullPath, file.content, file.relativePath));
      }
    }
  }

  if (writes.length > 0) {
    await Promise.all(writes);
  }
}

// -----------------------------------------------------------------------------
// File writer
// -----------------------------------------------------------------------------

async function writeGeneratedFile(fullPath: string, content: string, relativePath: string): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  console.log(`  Generated: ${relativePath} (${content.length} chars)`);
}
