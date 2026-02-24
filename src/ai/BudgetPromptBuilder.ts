import { compare } from "../core/utils.js";
import type {
  ProjectContext,
  HubContext,
  ChainContext,
  InsightContext,
} from "../context/ContextBuilder.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  error: 3,
  warning: 2,
  info: 1,
};

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

type SectionKind = "hub" | "deepChain" | "insight";

interface RankedSection {
  readonly kind: SectionKind;
  readonly priority: number;
  readonly label: string;
  readonly textContent: string;
  readonly mdContent: string;
}

// -----------------------------------------------------------------------------
// Token estimation
// -----------------------------------------------------------------------------

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// -----------------------------------------------------------------------------
// Section builders
// -----------------------------------------------------------------------------

function buildHubSection(hub: HubContext, index: number): RankedSection {
  const priority = hub.dependentCount;
  const label = `hub-${index + 1}`;
  const textContent = `Hub: ${hub.component} (dependents: ${hub.dependentCount}, confidence: ${hub.confidence})`;
  const mdContent = `### Hub: ${hub.component}\n\n- Dependents: ${hub.dependentCount}\n- Confidence: ${hub.confidence}`;
  return { kind: "hub", priority, label, textContent, mdContent };
}

function buildChainSection(chain: ChainContext, index: number): RankedSection {
  const priority = chain.length;
  const label = `chain-${index + 1}`;
  const chainStr =
    chain.components.length > 0
      ? chain.components.join(" -> ")
      : `${chain.root} -> ... -> ${chain.leaf}`;
  const textContent = `Chain (length ${chain.length}): ${chainStr}`;
  const mdContent = `### Chain (length ${chain.length})\n\n\`${chainStr}\``;
  return { kind: "deepChain", priority, label, textContent, mdContent };
}

function buildInsightSection(insight: InsightContext, index: number): RankedSection {
  const severityScore = SEVERITY_RANK[insight.severity] ?? 0;
  const priority = severityScore + insight.confidence;
  const label = `insight-${index + 1}`;
  const componentPart = insight.component !== undefined ? ` [${insight.component}]` : "";
  const messagePart = insight.message !== undefined ? ` — ${insight.message}` : "";
  const textContent = `[${insight.severity}] ${insight.type}${componentPart} (confidence: ${insight.confidence})${messagePart}`;
  const mdContent = `### [${insight.severity}] ${insight.type}${componentPart}\n\n- Confidence: ${insight.confidence}${messagePart !== "" ? `\n- ${insight.message}` : ""}`;
  return { kind: "insight", priority, label, textContent, mdContent };
}

// -----------------------------------------------------------------------------
// Summary builder
// -----------------------------------------------------------------------------

function buildSummaryText(context: ProjectContext): string {
  const lines: string[] = [];
  lines.push("Project Summary:");
  lines.push(`  Components: ${context.summary.totalComponents}`);
  lines.push(`  Hub Components: ${context.summary.hubCount}`);
  lines.push(`  Deep Chains: ${context.summary.deepChainCount}`);
  lines.push(`  Insights: ${context.summary.totalInsights}`);
  return lines.join("\n");
}

function buildSummaryMd(context: ProjectContext): string {
  const lines: string[] = [];
  lines.push("## Project Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Components | ${context.summary.totalComponents} |`);
  lines.push(`| Hub Components | ${context.summary.hubCount} |`);
  lines.push(`| Deep Chains | ${context.summary.deepChainCount} |`);
  lines.push(`| Insights | ${context.summary.totalInsights} |`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// BudgetPromptBuilder
// -----------------------------------------------------------------------------

/**
 * Builds a prompt that fits within a token budget, including the
 * highest-signal context sections first.
 *
 * Token estimation uses a simple whitespace-split word count.
 * All outputs are deterministic given identical context and budget.
 */
export class BudgetPromptBuilder {
  /**
   * Build a budget-constrained prompt from a ProjectContext.
   *
   * @param context - The project context to render.
   * @param options.budget - Maximum estimated token count.
   * @param options.format - Output format: "text" (default), "json", or "md".
   * @returns The rendered prompt string that does not exceed the budget.
   */
  static buildBudgetPrompt(
    context: ProjectContext,
    options: { budget: number; format?: "text" | "json" | "md" },
  ): string {
    const format = options.format ?? "text";
    const budget = options.budget;

    // Build and rank all sections
    const sections = BudgetPromptBuilder.buildRankedSections(context);

    // Build summary (always included)
    const summaryText = format === "md" ? buildSummaryMd(context) : buildSummaryText(context);
    const summaryTokens = estimateTokens(summaryText);

    // Group header overhead (tokens added when a category first appears)
    const GROUP_HEADERS: Readonly<Record<SectionKind, { text: string; md: string }>> = {
      hub: { text: "Hub Components:", md: "## Hub Components" },
      deepChain: { text: "Deep Dependency Chains:", md: "## Deep Dependency Chains" },
      insight: { text: "Insights:", md: "## Insights" },
    };

    // Greedily include sections in priority order, accounting for group header overhead
    let usedTokens = summaryTokens;
    const included: RankedSection[] = [];
    const seenKinds = new Set<SectionKind>();

    for (const section of sections) {
      const content = format === "md" ? section.mdContent : section.textContent;
      let sectionTokens = estimateTokens(content);

      // If this is the first section of its kind, add group header overhead
      if (!seenKinds.has(section.kind)) {
        const header = format === "md" ? GROUP_HEADERS[section.kind].md : GROUP_HEADERS[section.kind].text;
        sectionTokens += estimateTokens(header);
      }

      if (usedTokens + sectionTokens <= budget) {
        usedTokens += sectionTokens;
        seenKinds.add(section.kind);
        included.push(section);
      }
    }

    // Format output
    if (format === "json") {
      return BudgetPromptBuilder.formatJson(budget, usedTokens, included, summaryText);
    }
    if (format === "md") {
      return BudgetPromptBuilder.formatMd(summaryText, included);
    }
    return BudgetPromptBuilder.formatText(summaryText, included);
  }

  // ---------------------------------------------------------------------------
  // Private: section ranking
  // ---------------------------------------------------------------------------

  private static buildRankedSections(context: ProjectContext): readonly RankedSection[] {
    const sections: RankedSection[] = [];

    // Hubs — sorted by dependentCount desc, then component asc
    const sortedHubs = [...context.hubs].sort(
      (a, b) => (b.dependentCount - a.dependentCount) || compare(a.component, b.component),
    );
    for (let i = 0; i < sortedHubs.length; i++) {
      sections.push(buildHubSection(sortedHubs[i]!, i));
    }

    // Deep chains — sorted by length desc, then root asc
    const sortedChains = [...context.deepChains].sort(
      (a, b) => (b.length - a.length) || compare(a.root, b.root) || compare(a.leaf, b.leaf),
    );
    for (let i = 0; i < sortedChains.length; i++) {
      sections.push(buildChainSection(sortedChains[i]!, i));
    }

    // Insights — sorted by severity rank + confidence desc
    const sortedInsights = [...context.insights].sort((a, b) => {
      const aScore = (SEVERITY_RANK[a.severity] ?? 0) + a.confidence;
      const bScore = (SEVERITY_RANK[b.severity] ?? 0) + b.confidence;
      return (
        (bScore - aScore) ||
        compare(a.type, b.type) ||
        compare(a.component ?? "", b.component ?? "")
      );
    });
    for (let i = 0; i < sortedInsights.length; i++) {
      sections.push(buildInsightSection(sortedInsights[i]!, i));
    }

    // Global sort: priority desc, then kind order (hub > deepChain > insight), then label asc
    const KIND_ORDER: Readonly<Record<SectionKind, number>> = { hub: 0, deepChain: 1, insight: 2 };

    return [...sections].sort(
      (a, b) =>
        (b.priority - a.priority) ||
        (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) ||
        compare(a.label, b.label),
    );
  }

  // ---------------------------------------------------------------------------
  // Private: formatters
  // ---------------------------------------------------------------------------

  private static formatText(summary: string, sections: readonly RankedSection[]): string {
    const parts: string[] = [summary];

    const hubs = sections.filter((s) => s.kind === "hub");
    const chains = sections.filter((s) => s.kind === "deepChain");
    const insights = sections.filter((s) => s.kind === "insight");

    if (hubs.length > 0) {
      parts.push("");
      parts.push("Hub Components:");
      for (const s of hubs) {
        parts.push(`  ${s.textContent}`);
      }
    }

    if (chains.length > 0) {
      parts.push("");
      parts.push("Deep Dependency Chains:");
      for (const s of chains) {
        parts.push(`  ${s.textContent}`);
      }
    }

    if (insights.length > 0) {
      parts.push("");
      parts.push("Insights:");
      for (const s of insights) {
        parts.push(`  ${s.textContent}`);
      }
    }

    return parts.join("\n");
  }

  private static formatMd(summary: string, sections: readonly RankedSection[]): string {
    const parts: string[] = [summary];

    const hubs = sections.filter((s) => s.kind === "hub");
    const chains = sections.filter((s) => s.kind === "deepChain");
    const insights = sections.filter((s) => s.kind === "insight");

    if (hubs.length > 0) {
      parts.push("");
      parts.push("## Hub Components");
      for (const s of hubs) {
        parts.push("");
        parts.push(s.mdContent);
      }
    }

    if (chains.length > 0) {
      parts.push("");
      parts.push("## Deep Dependency Chains");
      for (const s of chains) {
        parts.push("");
        parts.push(s.mdContent);
      }
    }

    if (insights.length > 0) {
      parts.push("");
      parts.push("## Insights");
      for (const s of insights) {
        parts.push("");
        parts.push(s.mdContent);
      }
    }

    return parts.join("\n");
  }

  private static formatJson(
    budget: number,
    usedTokensEstimate: number,
    sections: readonly RankedSection[],
    summary: string,
  ): string {
    const sectionsIncluded: { kind: string; label: string; priority: number }[] = [];
    for (const s of sections) {
      sectionsIncluded.push({ kind: s.kind, label: s.label, priority: s.priority });
    }

    const output = {
      budget,
      usedTokensEstimate,
      summary,
      sectionsIncluded,
    };

    // Deterministic key order via sorted keys
    return JSON.stringify(output, null, 2);
  }
}
