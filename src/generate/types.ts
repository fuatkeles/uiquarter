import type { ProjectContext } from "../context/ContextBuilder.js";

// -----------------------------------------------------------------------------
// Target names
// -----------------------------------------------------------------------------

export type GenerateTargetName =
  | "claude"
  | "codex"
  | "cursor"
  | "windsurf"
  | "cline"
  | "copilot"
  | "aider";

// -----------------------------------------------------------------------------
// Generated file
// -----------------------------------------------------------------------------

export interface GeneratedFile {
  readonly relativePath: string;
  readonly content: string;
}

// -----------------------------------------------------------------------------
// Convention context (from FileStructureAnalyzer .:conventions:1 pattern)
// -----------------------------------------------------------------------------

export interface ConventionContext {
  readonly dominantFileNaming: string;
  readonly dominantDirNaming: string;
  readonly testStrategy: string;
  readonly styleStrategy: string;
  readonly barrelCount: number;
  readonly componentDirCount: number;
  readonly totalDirectories: number;
  readonly totalFiles: number;
}

// -----------------------------------------------------------------------------
// Generator context — wraps ProjectContext + optional conventions
// -----------------------------------------------------------------------------

export interface GeneratorContext {
  readonly project: ProjectContext;
  readonly conventions: ConventionContext | null;
}

// -----------------------------------------------------------------------------
// Formatter
// -----------------------------------------------------------------------------

export interface FormatterOptions {
  readonly charBudget?: number;
  readonly projectName?: string;
}

export type TargetFormatter = (
  context: GeneratorContext,
  options: FormatterOptions,
) => readonly GeneratedFile[];

// -----------------------------------------------------------------------------
// Target configuration
// -----------------------------------------------------------------------------

export interface TargetConfig {
  readonly name: GenerateTargetName;
  readonly displayName: string;
  readonly description: string;
  readonly defaultFiles: readonly string[];
  readonly defaultCharBudget?: number;
  readonly formatter: TargetFormatter;
}

// -----------------------------------------------------------------------------
// Command options
// -----------------------------------------------------------------------------

export interface GenerateCommandOptions {
  readonly target: GenerateTargetName | "all";
  readonly dir?: string;
  readonly dryRun?: boolean;
}
