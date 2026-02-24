import { resolve as resolvePath } from "node:path";
import { writeFile } from "node:fs/promises";
import { ContextBuilder } from "../context/ContextBuilder.js";
import type { ProjectContext } from "../context/ContextBuilder.js";
import { QueryEngine } from "../query/QueryEngine.js";
import { TaskScopedBuilder } from "../context/TaskScopedBuilder.js";
import { stableStringify } from "../core/utils.js";
import type { ScoredMatch } from "../query/ResolverScorer.js";

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface ExportCommandOptions {
  readonly type: "context" | "resolve" | "scope";
  readonly task?: string;
  readonly format?: "json" | "txt" | "md";
  readonly budget?: number;
  readonly synonyms?: boolean;
  readonly fuzzy?: boolean;
  readonly debug?: boolean;
  readonly out?: string;
  readonly dir?: string;
}

// -----------------------------------------------------------------------------
// Context formatters (exported for testing)
// -----------------------------------------------------------------------------

export function formatContextJson(ctx: ProjectContext): string {
  return stableStringify({
    project: ctx.summary,
    components: ctx.components,
    hubs: ctx.hubs,
    deepChains: ctx.deepChains,
    insights: ctx.insights,
  });
}

export function formatContextText(ctx: ProjectContext): string {
  const lines: string[] = [];

  lines.push("Project Context Summary");
  lines.push("=======================");
  lines.push(`Components: ${ctx.summary.totalComponents}`);
  lines.push(`Insights: ${ctx.summary.totalInsights}`);
  lines.push(`Hub components: ${ctx.summary.hubCount}`);
  lines.push(`Deep chains: ${ctx.summary.deepChainCount}`);
  lines.push("");

  if (ctx.components.length > 0) {
    lines.push("Components:");
    for (const c of ctx.components) {
      const tags: string[] = [];
      if (c.isHub) tags.push("hub");
      if (c.isOrphan) tags.push("orphan");
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      lines.push(`  ${c.name} (${c.filePath}) deps=${c.dependencyCount} dependents=${c.dependentCount}${tagStr}`);
    }
    lines.push("");
  }

  if (ctx.hubs.length > 0) {
    lines.push("Hub Components:");
    for (const h of ctx.hubs) {
      lines.push(`  ${h.component} dependents=${h.dependentCount} confidence=${h.confidence.toFixed(2)}`);
    }
    lines.push("");
  }

  if (ctx.deepChains.length > 0) {
    lines.push("Deep Chains:");
    for (const ch of ctx.deepChains) {
      lines.push(`  ${ch.root} -> ${ch.leaf} (length=${ch.length})`);
      if (ch.components.length > 0) {
        lines.push(`    chain: ${ch.components.join(" -> ")}`);
      }
    }
    lines.push("");
  }

  if (ctx.insights.length > 0) {
    lines.push("Insights:");
    for (const i of ctx.insights) {
      const comp = i.component ? ` [${i.component}]` : "";
      lines.push(`  [${i.severity}] ${i.type}${comp} (confidence=${i.confidence.toFixed(2)})`);
      if (i.message) lines.push(`    ${i.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatContextMarkdown(ctx: ProjectContext): string {
  const lines: string[] = [];

  lines.push("# Project Context\n");
  lines.push("## Summary\n");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Components | ${ctx.summary.totalComponents} |`);
  lines.push(`| Insights | ${ctx.summary.totalInsights} |`);
  lines.push(`| Hub components | ${ctx.summary.hubCount} |`);
  lines.push(`| Deep chains | ${ctx.summary.deepChainCount} |`);
  lines.push("");

  if (ctx.components.length > 0) {
    lines.push("## Components\n");
    lines.push("| Name | File | Deps | Dependents | Tags |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const c of ctx.components) {
      const tags: string[] = [];
      if (c.isHub) tags.push("hub");
      if (c.isOrphan) tags.push("orphan");
      lines.push(`| ${c.name} | ${c.filePath} | ${c.dependencyCount} | ${c.dependentCount} | ${tags.join(", ")} |`);
    }
    lines.push("");
  }

  if (ctx.hubs.length > 0) {
    lines.push("## Hub Components\n");
    for (const h of ctx.hubs) {
      lines.push(`- **${h.component}** — dependents: ${h.dependentCount}, confidence: ${h.confidence.toFixed(2)}`);
    }
    lines.push("");
  }

  if (ctx.deepChains.length > 0) {
    lines.push("## Deep Chains\n");
    for (const ch of ctx.deepChains) {
      lines.push(`- **${ch.root}** -> **${ch.leaf}** (length: ${ch.length})`);
      if (ch.components.length > 0) {
        lines.push(`  - Chain: ${ch.components.join(" -> ")}`);
      }
    }
    lines.push("");
  }

  if (ctx.insights.length > 0) {
    lines.push("## Insights\n");
    for (const i of ctx.insights) {
      const comp = i.component ? ` [${i.component}]` : "";
      lines.push(`- **${i.type}**${comp} (${i.severity}, confidence: ${i.confidence.toFixed(2)})`);
      if (i.message) lines.push(`  - ${i.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Resolve formatters (exported for testing)
// -----------------------------------------------------------------------------

export function formatResolveJson(results: readonly ScoredMatch[], debug: boolean): string {
  if (debug) {
    return stableStringify(results);
  }
  const stripped = results.map((r) => ({
    patternId: r.patternId,
    score: r.score,
    matchedTokens: r.matchedTokens,
  }));
  return stableStringify(stripped);
}

export function formatResolveText(task: string, results: readonly ScoredMatch[], debug: boolean): string {
  const lines: string[] = [];
  lines.push(`Resolve: "${task}" → ${results.length} match(es)\n`);

  for (const r of results) {
    lines.push(`  ${r.patternId as string}  (score: ${r.score.toFixed(2)})`);
    if (debug) {
      for (const reason of r.reasons) {
        lines.push(`    ${reason.token} [${reason.kind}] +${reason.weight.toFixed(1)} — ${reason.description}`);
      }
    }
  }

  return lines.join("\n");
}

export function formatResolveMarkdown(task: string, results: readonly ScoredMatch[], debug: boolean): string {
  const lines: string[] = [];
  lines.push(`# Resolve: "${task}"\n`);
  lines.push(`Found ${results.length} matching pattern(s).\n`);

  for (const r of results) {
    lines.push(`- **${r.patternId as string}** (score: ${r.score.toFixed(2)})`);
    if (debug) {
      for (const reason of r.reasons) {
        lines.push(`  - \`${reason.token}\` (${reason.kind}, +${reason.weight.toFixed(1)}) — ${reason.description}`);
      }
    }
  }

  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Output helper
// -----------------------------------------------------------------------------

async function emitOutput(content: string, outPath: string | undefined): Promise<void> {
  if (outPath !== undefined) {
    await writeFile(outPath, content, "utf-8");
  } else {
    process.stdout.write(content);
  }
}

// -----------------------------------------------------------------------------
// Command handler
// -----------------------------------------------------------------------------

/**
 * Run `uiquarter export`.
 *
 * @param options Export command options
 */
export async function runExportCommand(options: ExportCommandOptions): Promise<void> {
  const rootPath = resolvePath(options.dir ?? process.cwd());
  const format = options.format ?? "json";

  if (options.type === "context") {
    const builder = new ContextBuilder(rootPath);
    try {
      await builder.load();
    } catch {
      throw new Error("UIQuarter analysis not found. Run 'uiquarter init' first.");
    }
    const ctx = builder.buildProjectContext();

    let output: string;
    switch (format) {
      case "json":
        output = formatContextJson(ctx);
        break;
      case "md":
        output = formatContextMarkdown(ctx);
        break;
      default:
        output = formatContextText(ctx);
        break;
    }

    await emitOutput(output, options.out);
  } else if (options.type === "resolve") {
    if (options.task === undefined || options.task.length === 0) {
      throw new Error("Export type 'resolve' requires a --task argument.");
    }

    const engine = new QueryEngine(rootPath);
    try {
      await engine.load();
    } catch {
      throw new Error("UIQuarter index not found. Run 'uiquarter init' first.");
    }

    const debug = options.debug === true;
    const results = engine.resolveTask(options.task, {
      fuzzy: options.fuzzy,
      synonyms: options.synonyms,
      debug,
    });

    let output: string;
    switch (format) {
      case "json":
        output = formatResolveJson(results, debug);
        break;
      case "md":
        output = formatResolveMarkdown(options.task, results, debug);
        break;
      default:
        output = formatResolveText(options.task, results, debug);
        break;
    }

    await emitOutput(output, options.out);
  } else if (options.type === "scope") {
    if (options.task === undefined || options.task.length === 0) {
      throw new Error("Export type 'scope' requires a --task argument.");
    }

    const engine = new QueryEngine(rootPath);
    try {
      await engine.load();
    } catch {
      throw new Error("UIQuarter index not found. Run 'uiquarter init' first.");
    }

    const builder = new TaskScopedBuilder(engine);
    const scopeOpts = {
      synonyms: options.synonyms,
      fuzzy: options.fuzzy,
      charBudget: options.budget !== undefined ? options.budget * 4 : undefined,
    };

    let output: string;
    switch (format) {
      case "json":
        output = stableStringify(builder.build(options.task, scopeOpts));
        break;
      case "md":
        output = builder.buildMarkdown(options.task, scopeOpts);
        break;
      default:
        output = builder.buildText(options.task, scopeOpts);
        break;
    }

    await emitOutput(output, options.out);
  } else {
    throw new Error(`Unknown export type: ${String(options.type)}`);
  }
}
