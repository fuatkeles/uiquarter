import { compare } from "../core/utils.js";
import type { GenerateTargetName, TargetConfig } from "./types.js";
import { formatClaude } from "./formatters/claude.js";
import { formatCodex } from "./formatters/codex.js";
import { formatCursor } from "./formatters/cursor.js";
import { formatWindsurf } from "./formatters/windsurf.js";
import { formatCline } from "./formatters/cline.js";
import { formatCopilot } from "./formatters/copilot.js";
import { formatAider } from "./formatters/aider.js";

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const REGISTRY: ReadonlyMap<GenerateTargetName, TargetConfig> = new Map<GenerateTargetName, TargetConfig>([
  ["aider", {
    name: "aider",
    displayName: "Aider",
    description: "Conventions file for Aider",
    defaultFiles: ["CONVENTIONS.md"],
    formatter: formatAider,
  }],
  ["claude", {
    name: "claude",
    displayName: "Claude Code",
    description: "CLAUDE.md project instructions for Claude Code",
    defaultFiles: ["CLAUDE.md"],
    formatter: formatClaude,
  }],
  ["cline", {
    name: "cline",
    displayName: "Cline",
    description: ".clinerules instructions for Cline",
    defaultFiles: [".clinerules"],
    formatter: formatCline,
  }],
  ["codex", {
    name: "codex",
    displayName: "OpenAI Codex CLI",
    description: "AGENTS.md instructions for Codex CLI",
    defaultFiles: ["AGENTS.md"],
    defaultCharBudget: 32_768,
    formatter: formatCodex,
  }],
  ["copilot", {
    name: "copilot",
    displayName: "GitHub Copilot",
    description: "Custom instructions for GitHub Copilot",
    defaultFiles: [".github/copilot-instructions.md"],
    formatter: formatCopilot,
  }],
  ["cursor", {
    name: "cursor",
    displayName: "Cursor",
    description: ".cursorrules instructions for Cursor",
    defaultFiles: [".cursorrules"],
    formatter: formatCursor,
  }],
  ["windsurf", {
    name: "windsurf",
    displayName: "Windsurf",
    description: ".windsurfrules instructions for Windsurf",
    defaultFiles: [".windsurfrules"],
    defaultCharBudget: 6_000,
    formatter: formatWindsurf,
  }],
]);

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function getTargetConfig(name: GenerateTargetName): TargetConfig {
  const config = REGISTRY.get(name);
  if (config === undefined) {
    throw new Error(`Unknown generate target: ${name}`);
  }
  return config;
}

export function getAllTargetNames(): readonly GenerateTargetName[] {
  return [...REGISTRY.keys()].sort(compare);
}

export function getAllTargetConfigs(): readonly TargetConfig[] {
  return getAllTargetNames().map((name) => REGISTRY.get(name)!);
}
