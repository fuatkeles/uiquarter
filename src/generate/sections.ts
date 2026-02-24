import { compare } from "../core/utils.js";
import type { GeneratorContext, ConventionContext } from "./types.js";

// -----------------------------------------------------------------------------
// Section: Project overview
// -----------------------------------------------------------------------------

export function buildOverviewSection(ctx: GeneratorContext): string {
  const s = ctx.project.summary;
  const lines: string[] = [];
  lines.push("## Project Architecture Overview");
  lines.push("");
  lines.push(`This project contains **${s.totalComponents}** UI components.`);
  if (s.hubCount > 0) {
    lines.push(`**${s.hubCount}** hub component(s) serve as central connection points.`);
  }
  if (s.deepChainCount > 0) {
    lines.push(`**${s.deepChainCount}** deep dependency chain(s) detected.`);
  }
  lines.push(`**${s.totalInsights}** architectural insight(s) generated.`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Compact overview (for budget-constrained targets)
// -----------------------------------------------------------------------------

export function buildCompactOverviewSection(ctx: GeneratorContext): string {
  const s = ctx.project.summary;
  return [
    "## Architecture",
    "",
    `${s.totalComponents} components, ${s.hubCount} hubs, ${s.deepChainCount} deep chains, ${s.totalInsights} insights.`,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Section: Coding conventions
// -----------------------------------------------------------------------------

export function buildConventionsSection(conventions: ConventionContext | null): string {
  if (conventions === null) return "";

  const lines: string[] = [];
  lines.push("## Coding Conventions");
  lines.push("");
  lines.push(`- **File naming**: ${conventions.dominantFileNaming}`);
  lines.push(`- **Directory naming**: ${conventions.dominantDirNaming}`);
  lines.push(`- **Test strategy**: ${conventions.testStrategy}`);
  lines.push(`- **Style strategy**: ${conventions.styleStrategy}`);
  if (conventions.barrelCount > 0) {
    lines.push(`- **Barrel exports**: ${conventions.barrelCount} detected`);
  }
  if (conventions.componentDirCount > 0) {
    lines.push(`- **Component directories**: ${conventions.componentDirCount} detected`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Compact conventions (2-line summary)
// -----------------------------------------------------------------------------

export function buildCompactConventionsSection(conventions: ConventionContext | null): string {
  if (conventions === null) return "";
  return [
    "## Conventions",
    "",
    `Files: ${conventions.dominantFileNaming}, dirs: ${conventions.dominantDirNaming}, tests: ${conventions.testStrategy}, styles: ${conventions.styleStrategy}.`,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Section: Key components (hubs + orphans)
// -----------------------------------------------------------------------------

export function buildKeyComponentsSection(ctx: GeneratorContext): string {
  const { hubs, components } = ctx.project;
  if (hubs.length === 0 && components.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Key Components");
  lines.push("");

  if (hubs.length > 0) {
    lines.push("### Hub Components");
    lines.push("");
    lines.push("These components are imported by many others. Changes have wide impact.");
    lines.push("");
    const sorted = [...hubs].sort(
      (a, b) => (b.dependentCount - a.dependentCount) || compare(a.component, b.component),
    );
    for (const hub of sorted) {
      lines.push(`- **${hub.component}** — ${hub.dependentCount} dependents (confidence: ${hub.confidence.toFixed(2)})`);
    }
    lines.push("");
  }

  const orphans = components
    .filter((c) => c.isOrphan)
    .sort((a, b) => compare(a.name, b.name));
  if (orphans.length > 0) {
    lines.push("### Orphan Components");
    lines.push("");
    lines.push("These components have no dependents and may be unused.");
    lines.push("");
    for (const o of orphans) {
      lines.push(`- ${o.name} (\`${o.filePath}\`)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Hubs only (compact)
// -----------------------------------------------------------------------------

export function buildHubsOnlySection(ctx: GeneratorContext): string {
  if (ctx.project.hubs.length === 0) return "";

  const sorted = [...ctx.project.hubs].sort(
    (a, b) => (b.dependentCount - a.dependentCount) || compare(a.component, b.component),
  );
  const lines: string[] = [];
  lines.push("## Hub Components");
  lines.push("");
  for (const hub of sorted) {
    lines.push(`- **${hub.component}** (${hub.dependentCount} dependents)`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Component table
// -----------------------------------------------------------------------------

export function buildComponentTableSection(ctx: GeneratorContext): string {
  if (ctx.project.components.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Component Structure");
  lines.push("");
  lines.push("| Component | File | Deps | Dependents | Tags |");
  lines.push("|-----------|------|------|------------|------|");

  const sorted = [...ctx.project.components].sort((a, b) => compare(a.name, b.name));
  for (const c of sorted) {
    const tags: string[] = [];
    if (c.isHub) tags.push("hub");
    if (c.isOrphan) tags.push("orphan");
    lines.push(`| ${c.name} | \`${c.filePath}\` | ${c.dependencyCount} | ${c.dependentCount} | ${tags.join(", ")} |`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Dependency patterns
// -----------------------------------------------------------------------------

export function buildDependencySection(ctx: GeneratorContext): string {
  if (ctx.project.deepChains.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Dependency Patterns");
  lines.push("");
  lines.push("### Deep Dependency Chains");
  lines.push("");
  lines.push("Long chains increase coupling and make refactoring harder.");
  lines.push("");

  const sorted = [...ctx.project.deepChains].sort(
    (a, b) => (b.length - a.length) || compare(a.root, b.root),
  );
  for (const chain of sorted) {
    const chainStr = chain.components.length > 0
      ? chain.components.join(" → ")
      : `${chain.root} → … → ${chain.leaf}`;
    lines.push(`- Length ${chain.length}: \`${chainStr}\``);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Architectural insights
// -----------------------------------------------------------------------------

const SEVERITY_ORDER: Readonly<Record<string, number>> = { error: 0, warning: 1, info: 2 };

export function buildInsightsSection(ctx: GeneratorContext): string {
  if (ctx.project.insights.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Architectural Insights");
  lines.push("");

  const sorted = [...ctx.project.insights].sort(
    (a, b) =>
      ((SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)) ||
      (b.confidence - a.confidence) ||
      compare(a.type, b.type),
  );

  for (const insight of sorted) {
    const comp = insight.component ? ` [${insight.component}]` : "";
    const msg = insight.message ? ` — ${insight.message}` : "";
    lines.push(`- **${insight.severity}**: ${insight.type}${comp}${msg}`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Top N insights (for budget-constrained targets)
// -----------------------------------------------------------------------------

export function buildTopInsightsSection(ctx: GeneratorContext, maxCount: number): string {
  if (ctx.project.insights.length === 0) return "";

  const sorted = [...ctx.project.insights].sort(
    (a, b) =>
      ((SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)) ||
      (b.confidence - a.confidence) ||
      compare(a.type, b.type),
  );

  const top = sorted.slice(0, maxCount);
  const lines: string[] = [];
  lines.push("## Key Insights");
  lines.push("");
  for (const insight of top) {
    const comp = insight.component ? ` [${insight.component}]` : "";
    lines.push(`- **${insight.severity}**: ${insight.type}${comp}`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Development guidelines
// -----------------------------------------------------------------------------

export function buildGuidelinesSection(ctx: GeneratorContext): string {
  const { hubs, deepChains, insights, components } = ctx.project;
  const lines: string[] = [];
  lines.push("## Development Guidelines");
  lines.push("");

  if (hubs.length > 0) {
    const hubNames = [...hubs].sort((a, b) => compare(a.component, b.component)).map((h) => h.component).join(", ");
    lines.push(`- **Hub components** (${hubNames}): Changes have wide impact. Test thoroughly and check all dependents.`);
  }

  const cycles = insights.filter((i) => i.type === "dependency-cycle");
  if (cycles.length > 0) {
    lines.push("- **Dependency cycles detected**: Avoid deepening circular dependencies. Extract shared logic into separate modules.");
  }

  if (deepChains.length > 0) {
    lines.push(`- **Deep dependency chains**: ${deepChains.length} chain(s) with long import paths. Consider flattening or introducing facade components.`);
  }

  const orphans = components.filter((c) => c.isOrphan);
  if (orphans.length > 0) {
    lines.push(`- **Orphan components** (${orphans.length}): No dependents found. Verify they are still needed before modifying.`);
  }

  if (lines.length === 2) return ""; // Only header + empty line
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Directive-style guidelines (for cursor/cline)
// -----------------------------------------------------------------------------

export function buildDirectiveGuidelinesSection(ctx: GeneratorContext): string {
  const { hubs, deepChains, insights, components } = ctx.project;
  const lines: string[] = [];
  lines.push("## Rules");
  lines.push("");

  if (hubs.length > 0) {
    for (const hub of [...hubs].sort((a, b) => compare(a.component, b.component))) {
      lines.push(`- When modifying \`${hub.component}\`, check all ${hub.dependentCount} dependents for breakage.`);
    }
  }

  const cycles = insights.filter((i) => i.type === "dependency-cycle");
  if (cycles.length > 0) {
    lines.push("- Do not introduce new circular dependencies between modules.");
  }

  if (deepChains.length > 0) {
    lines.push("- Prefer shallow imports. Avoid adding new links to existing deep dependency chains.");
  }

  const orphans = components.filter((c) => c.isOrphan);
  if (orphans.length > 0) {
    lines.push("- Before modifying orphan components, confirm they are still used in the project.");
  }

  if (lines.length === 2) return "";
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Section: Instruction-style guidelines (for copilot)
// -----------------------------------------------------------------------------

export function buildInstructionGuidelinesSection(ctx: GeneratorContext): string {
  const { hubs, deepChains, insights, components } = ctx.project;
  const lines: string[] = [];
  lines.push("## Instructions");
  lines.push("");

  if (hubs.length > 0) {
    const hubNames = [...hubs].sort((a, b) => compare(a.component, b.component)).map((h) => `\`${h.component}\``).join(", ");
    lines.push(`When modifying hub components (${hubNames}), ensure all dependents are tested and updated.`);
    lines.push("");
  }

  const cycles = insights.filter((i) => i.type === "dependency-cycle");
  if (cycles.length > 0) {
    lines.push("When adding imports, avoid creating or deepening circular dependencies.");
    lines.push("");
  }

  if (deepChains.length > 0) {
    lines.push("When adding dependencies, prefer direct imports over deeply nested chains.");
    lines.push("");
  }

  const orphans = components.filter((c) => c.isOrphan);
  if (orphans.length > 0) {
    lines.push(`There are ${orphans.length} orphan component(s) with no dependents. Verify usage before modifying them.`);
    lines.push("");
  }

  if (lines.length === 2) return "";
  return lines.join("\n").trimEnd();
}

// -----------------------------------------------------------------------------
// Budget helper
// -----------------------------------------------------------------------------

/**
 * Greedily compose sections within a character budget.
 * The first section is always included regardless of budget.
 */
export function composeSectionsWithBudget(
  sections: readonly string[],
  charBudget: number,
): string {
  const nonEmpty = sections.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return "";

  const result: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < nonEmpty.length; i++) {
    const section = nonEmpty[i]!;
    const separator = result.length > 0 ? 2 : 0; // "\n\n" between sections

    if (i === 0) {
      result.push(section);
      totalChars += section.length;
      continue;
    }

    if (totalChars + separator + section.length <= charBudget) {
      result.push(section);
      totalChars += separator + section.length;
    }
  }

  return result.join("\n\n");
}
