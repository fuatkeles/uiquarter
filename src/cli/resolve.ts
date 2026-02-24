import { QueryEngine } from "../query/QueryEngine.js";
import { stableStringify } from "../core/utils.js";
import type { ScoredMatch } from "../query/ResolverScorer.js";

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface ResolveCommandOptions {
  readonly synonyms?: boolean;
  readonly fuzzy?: boolean;
  readonly debug?: boolean;
  readonly format?: string;
}

// -----------------------------------------------------------------------------
// Formatters (exported for testing)
// -----------------------------------------------------------------------------

export function formatText(task: string, results: readonly ScoredMatch[], debug: boolean): string {
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

export function formatMarkdown(task: string, results: readonly ScoredMatch[], debug: boolean): string {
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

export function formatJson(results: readonly ScoredMatch[], debug: boolean): string {
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

// -----------------------------------------------------------------------------
// Command handler
// -----------------------------------------------------------------------------

/**
 * Run `uiquarter resolve <task>`.
 *
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function runResolveCommand(
  rootPath: string,
  task: string,
  options: ResolveCommandOptions,
): Promise<number> {
  const engine = new QueryEngine(rootPath);

  try {
    await engine.load();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const debug = options.debug === true;

  const results = engine.resolveTask(task, {
    fuzzy: options.fuzzy,
    synonyms: options.synonyms,
    debug,
  });

  if (results.length === 0) {
    console.log("No matching patterns found.");
    return 0;
  }

  const format = options.format ?? "text";

  switch (format) {
    case "json":
      console.log(formatJson(results, debug));
      break;
    case "md":
      console.log(formatMarkdown(task, results, debug));
      break;
    default:
      console.log(formatText(task, results, debug));
      break;
  }

  return 0;
}
