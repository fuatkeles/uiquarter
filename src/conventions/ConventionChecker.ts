import { readFile } from "node:fs/promises";
import { join, basename, dirname, extname } from "node:path";
import { compare } from "../core/utils.js";
import type { IntelligenceIndex, PatternResult } from "../types/index.js";
import type { Insight } from "../types/index.js";
import type {
  ConventionViolation,
  ConventionCheckResult,
  UiqrcConfig,
  ConventionRuleConfig,
} from "./types.js";

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

const DEFAULT_RULES: Record<string, ConventionRuleConfig> = {
  "file-naming": { severity: "warning", enabled: true },
  "dir-naming": { severity: "warning", enabled: true },
  "component-naming": { severity: "warning", enabled: true },
  "barrel-exports": { severity: "info", enabled: true },
  "circular-deps": { severity: "error", enabled: true },
  "max-chain-depth": { severity: "warning", enabled: true },
  "single-styling": { severity: "warning", enabled: true },
  "min-accessibility": { severity: "warning", enabled: true, threshold: 0.5 },
  "max-nesting-depth": { severity: "warning", enabled: true, maxDepth: 8 },
  "test-colocation": { severity: "info", enabled: true },
};

// -----------------------------------------------------------------------------
// Naming convention helpers
// -----------------------------------------------------------------------------

type NamingConvention = "kebab-case" | "camelCase" | "PascalCase" | "snake_case" | "unknown";

function detectNamingConvention(name: string): NamingConvention {
  // Strip extension
  const base = name.replace(/\.[^.]+$/, "");
  if (!base) return "unknown";

  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(base)) return "kebab-case";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(base)) return "PascalCase";
  if (/^[a-z][a-zA-Z0-9]*$/.test(base)) return "camelCase";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(base)) return "snake_case";
  return "unknown";
}

function findDominantConvention(names: string[]): NamingConvention | null {
  const counts: Record<string, number> = {};
  for (const n of names) {
    const conv = detectNamingConvention(n);
    if (conv !== "unknown") {
      counts[conv] = (counts[conv] ?? 0) + 1;
    }
  }

  let best: NamingConvention | null = null;
  let bestCount = 0;
  for (const [conv, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = conv as NamingConvention;
      bestCount = count;
    }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Convention checker
// -----------------------------------------------------------------------------

export class ConventionChecker {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async check(
    index: IntelligenceIndex,
    insights: readonly Insight[],
  ): Promise<ConventionCheckResult> {
    // Load config
    const config = await this.loadConfig();

    // Merge defaults with user config
    const rules: Record<string, ConventionRuleConfig> = {};
    for (const [id, defaultCfg] of Object.entries(DEFAULT_RULES)) {
      const userCfg = config.rules?.[id] ?? {};
      rules[id] = { ...defaultCfg, ...userCfg };
    }

    const violations: ConventionViolation[] = [];
    let rulesChecked = 0;
    const filesChecked = new Set<string>();

    // Collect file paths from the index
    if (index.fileIndex) {
      const fileIndexEntries =
        index.fileIndex instanceof Map
          ? index.fileIndex
          : new Map(Object.entries(index.fileIndex));
      for (const filePath of fileIndexEntries.keys()) {
        filesChecked.add(filePath);
      }
    }

    // Run each enabled rule
    for (const [ruleId, ruleCfg] of Object.entries(rules)) {
      if (ruleCfg.enabled === false) continue;
      rulesChecked++;

      switch (ruleId) {
        case "file-naming":
          violations.push(...this.checkFileNaming(index, ruleCfg));
          break;
        case "dir-naming":
          violations.push(...this.checkDirNaming(index, ruleCfg));
          break;
        case "component-naming":
          violations.push(...this.checkComponentNaming(index, ruleCfg));
          break;
        case "barrel-exports":
          violations.push(...this.checkBarrelExports(index, ruleCfg));
          break;
        case "circular-deps":
          violations.push(...this.checkCircularDeps(insights, ruleCfg));
          break;
        case "max-chain-depth":
          violations.push(...this.checkMaxChainDepth(insights, ruleCfg));
          break;
        case "single-styling":
          violations.push(...this.checkSingleStylingParadigm(insights, ruleCfg));
          break;
        case "min-accessibility":
          violations.push(...this.checkMinAccessibility(index, ruleCfg));
          break;
        case "max-nesting-depth":
          violations.push(...this.checkMaxNestingDepth(index, ruleCfg));
          break;
        case "test-colocation":
          violations.push(...this.checkTestColocation(index, ruleCfg));
          break;
      }
    }

    // Sort violations: errors first, then warnings, then info
    const sorted = [...violations].sort((a, b) => {
      const severityOrder: Record<string, number> = {
        error: 0,
        warning: 1,
        info: 2,
      };
      const sa = severityOrder[a.severity] ?? 3;
      const sb = severityOrder[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      return compare(a.ruleId, b.ruleId);
    });

    return {
      violations: sorted,
      rulesChecked,
      filesChecked: filesChecked.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Config loading
  // ---------------------------------------------------------------------------

  private async loadConfig(): Promise<UiqrcConfig> {
    try {
      const raw = await readFile(join(this.rootPath, ".uiqrc.json"), "utf-8");
      return JSON.parse(raw) as UiqrcConfig;
    } catch {
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Individual rule checks
  // ---------------------------------------------------------------------------

  private getPatterns(index: IntelligenceIndex): PatternResult[] {
    const entries =
      index.entries instanceof Map
        ? index.entries
        : new Map(Object.entries(index.entries));
    return [...entries.values()] as PatternResult[];
  }

  private checkFileNaming(
    index: IntelligenceIndex,
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "warning";
    const patterns = this.getPatterns(index);
    const fileNames = patterns.map((p) => basename(p.filePath));

    // Check if conventions metadata is available
    let dominantConvention: NamingConvention | null = null;

    // Try to find the conventions pattern metadata
    for (const p of patterns) {
      const meta = p.metadata as Record<string, unknown>;
      if (meta?.dominantFileNaming) {
        dominantConvention = meta.dominantFileNaming as NamingConvention;
        break;
      }
    }

    if (!dominantConvention) {
      dominantConvention = findDominantConvention(fileNames);
    }

    if (!dominantConvention) return violations;

    for (const p of patterns) {
      const name = basename(p.filePath);
      const conv = detectNamingConvention(name);
      if (conv !== "unknown" && conv !== dominantConvention) {
        violations.push({
          ruleId: "file-naming",
          severity: severity as "error" | "warning" | "info",
          filePath: p.filePath,
          message: `File '${name}' uses ${conv} but project convention is ${dominantConvention}`,
          suggestion: `Rename to match ${dominantConvention} convention`,
        });
      }
    }

    return violations;
  }

  private checkDirNaming(
    index: IntelligenceIndex,
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "warning";
    const patterns = this.getPatterns(index);

    // Collect unique directory names
    const dirNames = new Set<string>();
    const dirPaths = new Map<string, string>();
    for (const p of patterns) {
      const dir = dirname(p.filePath);
      const dirName = basename(dir);
      if (dirName && dirName !== ".") {
        dirNames.add(dirName);
        if (!dirPaths.has(dirName)) {
          dirPaths.set(dirName, dir);
        }
      }
    }

    const dominant = findDominantConvention([...dirNames]);
    if (!dominant) return violations;

    for (const dirName of dirNames) {
      const conv = detectNamingConvention(dirName);
      if (conv !== "unknown" && conv !== dominant) {
        violations.push({
          ruleId: "dir-naming",
          severity: severity as "error" | "warning" | "info",
          filePath: dirPaths.get(dirName) ?? "",
          message: `Directory '${dirName}' uses ${conv} but project convention is ${dominant}`,
          suggestion: `Rename to match ${dominant} convention`,
        });
      }
    }

    return violations;
  }

  private checkComponentNaming(
    index: IntelligenceIndex,
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "warning";
    const patterns = this.getPatterns(index);

    for (const p of patterns) {
      if (p.type !== "component") continue;

      const fileName = basename(p.filePath).replace(extname(p.filePath), "");
      const componentName = p.name;

      // Component name should be PascalCase
      if (!/^[A-Z]/.test(componentName)) {
        violations.push({
          ruleId: "component-naming",
          severity: severity as "error" | "warning" | "info",
          filePath: p.filePath,
          message: `Component '${componentName}' should use PascalCase naming`,
          suggestion: `Rename to ${componentName.charAt(0).toUpperCase() + componentName.slice(1)}`,
        });
        continue;
      }

      // Component name should match file name (comparing PascalCase)
      const normalizedFileName = fileName.replace(/[-_.]/g, "");
      const normalizedComponent = componentName.replace(/[-_.]/g, "");
      if (
        normalizedFileName.toLowerCase() !== normalizedComponent.toLowerCase() &&
        fileName.toLowerCase() !== "index"
      ) {
        violations.push({
          ruleId: "component-naming",
          severity: severity as "error" | "warning" | "info",
          filePath: p.filePath,
          message: `Component '${componentName}' does not match filename '${fileName}'`,
          suggestion: `Rename file to '${componentName}${extname(p.filePath)}' or rename component to match filename`,
        });
      }
    }

    return violations;
  }

  private checkBarrelExports(
    index: IntelligenceIndex,
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "info";
    const patterns = this.getPatterns(index);

    // Group component files by directory
    const dirComponents = new Map<string, string[]>();
    const dirHasIndex = new Set<string>();

    for (const p of patterns) {
      if (p.type !== "component") continue;
      const dir = dirname(p.filePath);
      if (!dirComponents.has(dir)) {
        dirComponents.set(dir, []);
      }
      dirComponents.get(dir)!.push(p.filePath);

      // Check if this file is an index file
      const name = basename(p.filePath).replace(extname(p.filePath), "");
      if (name === "index") {
        dirHasIndex.add(dir);
      }
    }

    // Also check fileIndex for index files
    const fileIndex =
      index.fileIndex instanceof Map
        ? index.fileIndex
        : new Map(Object.entries(index.fileIndex ?? {}));

    for (const filePath of fileIndex.keys()) {
      const name = basename(filePath).replace(extname(filePath), "");
      if (name === "index") {
        dirHasIndex.add(dirname(filePath));
      }
    }

    for (const [dir, files] of dirComponents) {
      if (files.length >= 3 && !dirHasIndex.has(dir)) {
        violations.push({
          ruleId: "barrel-exports",
          severity: severity as "error" | "warning" | "info",
          filePath: dir,
          message: `Directory '${basename(dir)}' has ${files.length} component files but no index.ts barrel export`,
          suggestion: `Create an index.ts that re-exports all components from this directory`,
        });
      }
    }

    return violations;
  }

  private checkCircularDeps(
    insights: readonly Insight[],
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "error";

    for (const insight of insights) {
      if (insight.category === "dependency-cycle") {
        violations.push({
          ruleId: "circular-deps",
          severity: severity as "error" | "warning" | "info",
          filePath: "",
          message: insight.title,
          suggestion: insight.description,
        });
      }
    }

    return violations;
  }

  private checkMaxChainDepth(
    insights: readonly Insight[],
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "warning";

    for (const insight of insights) {
      if (insight.category === "deep-dependency-chain") {
        violations.push({
          ruleId: "max-chain-depth",
          severity: severity as "error" | "warning" | "info",
          filePath: "",
          message: insight.title,
          suggestion: insight.description,
        });
      }
    }

    return violations;
  }

  private checkSingleStylingParadigm(
    insights: readonly Insight[],
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "warning";

    for (const insight of insights) {
      if (insight.category === "mixed-styling") {
        violations.push({
          ruleId: "single-styling",
          severity: severity as "error" | "warning" | "info",
          filePath: "",
          message: insight.title,
          suggestion: insight.description,
        });
      }
    }

    return violations;
  }

  private checkMinAccessibility(
    index: IntelligenceIndex,
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "warning";
    const threshold = (config.threshold as number) ?? 0.5;
    const patterns = this.getPatterns(index);

    // Look for ux-summary metadata with accessibility coverage
    for (const p of patterns) {
      const meta = p.metadata as Record<string, unknown>;
      if (meta?.accessibilityCoverage !== undefined) {
        const coverage = Number(meta.accessibilityCoverage);
        if (!isNaN(coverage) && coverage < threshold) {
          violations.push({
            ruleId: "min-accessibility",
            severity: severity as "error" | "warning" | "info",
            filePath: p.filePath,
            message: `Accessibility coverage ${(coverage * 100).toFixed(0)}% is below minimum threshold of ${(threshold * 100).toFixed(0)}%`,
            suggestion: `Add ARIA labels, roles, and keyboard navigation support`,
          });
        }
      }
    }

    return violations;
  }

  private checkMaxNestingDepth(
    index: IntelligenceIndex,
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "warning";
    const maxDepth = (config.maxDepth as number) ?? 8;
    const patterns = this.getPatterns(index);

    // Look for file-structure conventions pattern with maxDepth metadata
    for (const p of patterns) {
      const meta = p.metadata as Record<string, unknown>;
      if (meta?.maxDepth !== undefined) {
        const depth = Number(meta.maxDepth);
        if (!isNaN(depth) && depth > maxDepth) {
          violations.push({
            ruleId: "max-nesting-depth",
            severity: severity as "error" | "warning" | "info",
            filePath: p.filePath,
            message: `Directory nesting depth ${depth} exceeds maximum of ${maxDepth}`,
            suggestion: `Flatten directory structure to reduce nesting depth`,
          });
        }
      }
    }

    return violations;
  }

  private checkTestColocation(
    index: IntelligenceIndex,
    config: ConventionRuleConfig,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = [];
    const severity = config.severity ?? "info";
    const patterns = this.getPatterns(index);

    // Look for test strategy metadata
    for (const p of patterns) {
      const meta = p.metadata as Record<string, unknown>;
      if (meta?.testStrategy !== undefined) {
        const strategy = String(meta.testStrategy);
        if (strategy !== "co-located" && strategy !== "colocated") {
          violations.push({
            ruleId: "test-colocation",
            severity: severity as "error" | "warning" | "info",
            filePath: p.filePath,
            message: `Test strategy is '${strategy}' — co-located tests are preferred`,
            suggestion: `Move test files next to the source files they test`,
          });
        }
      }
    }

    return violations;
  }
}

// -----------------------------------------------------------------------------
// Formatters
// -----------------------------------------------------------------------------

export function formatViolationsText(result: ConventionCheckResult): string {
  const lines: string[] = [];

  lines.push("Convention Check Results");
  lines.push("=======================");
  lines.push("");
  lines.push(`Rules checked: ${result.rulesChecked}`);
  lines.push(`Files checked: ${result.filesChecked}`);
  lines.push(`Violations: ${result.violations.length}`);
  lines.push("");

  if (result.violations.length === 0) {
    lines.push("No violations found.");
    return lines.join("\n");
  }

  const errors = result.violations.filter((v) => v.severity === "error");
  const warnings = result.violations.filter((v) => v.severity === "warning");
  const infos = result.violations.filter((v) => v.severity === "info");

  lines.push(
    `  Errors: ${errors.length}  Warnings: ${warnings.length}  Info: ${infos.length}`,
  );
  lines.push("");

  for (const v of result.violations) {
    const prefix = v.severity === "error" ? "ERR" : v.severity === "warning" ? "WRN" : "INF";
    const filePart = v.filePath ? ` (${v.filePath})` : "";
    lines.push(`  [${prefix}] ${v.ruleId}${filePart}`);
    lines.push(`        ${v.message}`);
    if (v.suggestion) {
      lines.push(`        -> ${v.suggestion}`);
    }
  }

  return lines.join("\n");
}

export function formatViolationsMarkdown(result: ConventionCheckResult): string {
  const lines: string[] = [];

  lines.push("# Convention Check Results");
  lines.push("");
  lines.push(`**Rules checked:** ${result.rulesChecked}`);
  lines.push(`**Files checked:** ${result.filesChecked}`);
  lines.push(`**Violations:** ${result.violations.length}`);
  lines.push("");

  if (result.violations.length === 0) {
    lines.push("*No violations found.*");
    return lines.join("\n");
  }

  const errors = result.violations.filter((v) => v.severity === "error");
  const warnings = result.violations.filter((v) => v.severity === "warning");
  const infos = result.violations.filter((v) => v.severity === "info");

  lines.push(
    `| Severity | Count |`,
  );
  lines.push(`|----------|-------|`);
  lines.push(`| Errors | ${errors.length} |`);
  lines.push(`| Warnings | ${warnings.length} |`);
  lines.push(`| Info | ${infos.length} |`);
  lines.push("");

  lines.push("## Violations");
  lines.push("");

  for (const v of result.violations) {
    const icon = v.severity === "error" ? "x" : v.severity === "warning" ? "!" : "i";
    const filePart = v.filePath ? ` \`${v.filePath}\`` : "";
    lines.push(`- **[${icon}] ${v.ruleId}**${filePart}`);
    lines.push(`  ${v.message}`);
    if (v.suggestion) {
      lines.push(`  > ${v.suggestion}`);
    }
  }

  return lines.join("\n");
}

export function formatViolationsJson(result: ConventionCheckResult): string {
  return JSON.stringify(
    {
      rulesChecked: result.rulesChecked,
      filesChecked: result.filesChecked,
      totalViolations: result.violations.length,
      summary: {
        errors: result.violations.filter((v) => v.severity === "error").length,
        warnings: result.violations.filter((v) => v.severity === "warning").length,
        info: result.violations.filter((v) => v.severity === "info").length,
      },
      violations: result.violations,
    },
    null,
    2,
  );
}
