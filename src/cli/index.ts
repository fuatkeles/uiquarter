#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { registerInitCommand } from "./init.js";
import { runQueryCommand } from "./query.js";
import { runExplainCommand } from "./explain.js";
import { runPromptCommand } from "./prompt.js";
import { runResolveCommand } from "./resolve.js";
import { runWatchCommand } from "./watch.js";
import { runExportCommand } from "./export.js";
import { runGenerateCommand } from "./generate.js";
import { runDriftCommand } from "./drift.js";
import { runServeCommand } from "./serve.js";
import { runCiCommand } from "./ci.js";
import { runLintCommand } from "./lint.js";
import { runReportCommand } from "./report.js";

const program = new Command();

program
  .name("uiquarter")
  .description("UI component analysis and resolution CLI")
  .version("0.1.0");

// ── Init command (full pipeline) ────────────────────────────────────────────
registerInitCommand(program);

// ── Query command ───────────────────────────────────────────────────────────
program
  .command("query")
  .description("Query the intelligence index and insights")
  .option("-d, --dir <path>", "root directory", ".")
  .allowUnknownOption(true)
  .action(async (opts: { dir: string }, cmd: Command) => {
    try {
      const rootPath = resolve(opts.dir);
      const args = cmd.args;
      const exitCode = await runQueryCommand(rootPath, args);
      process.exitCode = exitCode;
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ── Explain command ─────────────────────────────────────────────────────────
program
  .command("explain")
  .description("Explain project architecture")
  .option("-d, --dir <path>", "root directory", ".")
  .action(async (opts: { dir: string }) => {
    try {
      await runExplainCommand(resolve(opts.dir));
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ── Prompt command ──────────────────────────────────────────────────────────
program
  .command("prompt")
  .description("Print AI-optimized architecture context")
  .option("--dir <path>", "Project directory")
  .option("--budget <tokens>", "Maximum token budget (approximate)")
  .option("--format <type>", "Output format: text, md, json")
  .action(async (opts: { dir?: string; budget?: string; format?: string }) => {
    try {
      await runPromptCommand({
        dir: opts.dir,
        budget: opts.budget !== undefined ? Number(opts.budget) : undefined,
        format: opts.format,
      });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ── Removed stubs ────────────────────────────────────────────────────────────
// "analyze" and "index" were previously stubs. The `init` command handles
// file discovery, analysis, and index building in a single pipeline.
// No separate commands are needed.

program
  .command("resolve")
  .description("Resolve a free-form task to matching patterns")
  .argument("<task>", "free-form task description")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--synonyms", "enable synonym expansion")
  .option("--fuzzy", "enable fuzzy matching (edit distance 1)")
  .option("--debug", "show per-token match details")
  .option("--format <type>", "output format: text, md, json", "text")
  .action(async (task: string, opts: { dir: string; synonyms?: boolean; fuzzy?: boolean; debug?: boolean; format?: string }) => {
    const exitCode = await runResolveCommand(resolve(opts.dir), task, {
      synonyms: opts.synonyms,
      fuzzy: opts.fuzzy,
      debug: opts.debug,
      format: opts.format,
    });
    process.exitCode = exitCode;
  });

program
  .command("watch")
  .description("Watch for file changes and re-analyze incrementally")
  .option("-d, --dir <path>", "root directory to watch", ".")
  .option("--debounce <ms>", "debounce delay in milliseconds", "300")
  .option("--verbose", "show detailed analysis logs")
  .action(async (opts: { dir: string; debounce?: string; verbose?: boolean }) => {
    try {
      await runWatchCommand({
        dir: resolve(opts.dir),
        debounceMs: opts.debounce !== undefined ? Number(opts.debounce) : undefined,
        verbose: opts.verbose,
      });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("export")
  .description("Export resolved patterns or project context to disk")
  .requiredOption("-t, --type <type>", "export type: context, resolve, or scope")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--task <text>", "task description (required for type=resolve or scope)")
  .option("--format <type>", "output format: json, txt, md", "json")
  .option("--budget <tokens>", "token budget for scope export")
  .option("--out <path>", "output file path (default: stdout)")
  .option("--synonyms", "enable synonym expansion (resolve)")
  .option("--fuzzy", "enable fuzzy matching (resolve)")
  .option("--debug", "include debug scoring details (resolve)")
  .action(async (opts: {
    type: string;
    dir: string;
    task?: string;
    format?: string;
    budget?: string;
    out?: string;
    synonyms?: boolean;
    fuzzy?: boolean;
    debug?: boolean;
  }) => {
    try {
      await runExportCommand({
        type: opts.type as "context" | "resolve" | "scope",
        dir: resolve(opts.dir),
        task: opts.task,
        format: (opts.format ?? "json") as "json" | "txt" | "md",
        budget: opts.budget !== undefined ? Number(opts.budget) : undefined,
        synonyms: opts.synonyms,
        fuzzy: opts.fuzzy,
        debug: opts.debug,
        out: opts.out,
      });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("generate")
  .description("Generate AI tool context files from project analysis")
  .option("--target <name>", "target: claude, codex, cursor, windsurf, cline, copilot, aider, or all", "all")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--dry-run", "preview without writing files")
  .action(async (opts: { target: string; dir: string; dryRun?: boolean }) => {
    try {
      await runGenerateCommand({
        target: opts.target as "claude" | "codex" | "cursor" | "windsurf" | "cline" | "copilot" | "aider" | "all",
        dir: resolve(opts.dir),
        dryRun: opts.dryRun,
      });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("drift")
  .description("Detect changes between saved baseline and current analysis")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--format <type>", "output format: text, md, json", "text")
  .option("--save", "save current state as baseline snapshot")
  .option("--compare <branch>", "compare current state against another branch")
  .action(async (opts: { dir: string; format?: string; save?: boolean; compare?: string }) => {
    try {
      await runDriftCommand({
        dir: resolve(opts.dir),
        format: (opts.format ?? "text") as "text" | "md" | "json",
        save: opts.save,
        compare: opts.compare,
      });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("serve")
  .description("Start MCP server for AI tool integration")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--transport <type>", "transport: stdio or http", "stdio")
  .option("--port <number>", "HTTP port (for http transport)", "3100")
  .action(async (opts: { dir: string; transport?: string; port?: string }) => {
    try {
      await runServeCommand({
        dir: resolve(opts.dir),
        transport: opts.transport,
        port: opts.port,
      });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("ci")
  .description("Run CI checks and generate architecture report")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--fail-on <severity>", "fail on: error, warning, info, none", "error")
  .option("--format <type>", "output format: text, md, json", "md")
  .option("--output <path>", "write report to file")
  .option("--pr <number>", "post comment on GitHub PR")
  .option("--repo <owner/repo>", "GitHub repository for PR comments")
  .option("--update", "update existing PR comment instead of creating new")
  .option("--template", "print GitHub Action workflow template")
  .action(async (opts: {
    dir: string;
    failOn?: string;
    format?: string;
    output?: string;
    pr?: string;
    repo?: string;
    update?: boolean;
    template?: boolean;
  }) => {
    try {
      const exitCode = await runCiCommand({
        dir: resolve(opts.dir),
        failOn: opts.failOn,
        format: opts.format,
        output: opts.output,
        pr: opts.pr,
        repo: opts.repo,
        update: opts.update,
        template: opts.template,
      });
      process.exitCode = exitCode;
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("lint")
  .description("Check project conventions and architectural rules")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--format <type>", "output format: text, md, json", "text")
  .option("--output <path>", "write results to file")
  .action(async (opts: { dir: string; format?: string; output?: string }) => {
    try {
      const exitCode = await runLintCommand({
        dir: resolve(opts.dir),
        format: opts.format,
        output: opts.output,
      });
      process.exitCode = exitCode;
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("report")
  .description("Generate interactive HTML report")
  .option("-d, --dir <path>", "root directory", ".")
  .option("--output <path>", "output file path", "uiquarter-report.html")
  .option("--open", "open report in browser after generation")
  .action(async (opts: { dir: string; output?: string; open?: boolean }) => {
    try {
      await runReportCommand({
        dir: resolve(opts.dir),
        output: opts.output,
        open: opts.open,
      });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program.parse();
